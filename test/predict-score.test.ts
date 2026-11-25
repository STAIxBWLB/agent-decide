import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, main } from "../src/cli.ts";
import { UsageError } from "../src/contract.ts";
import { evaluate, parseRows, predict, score } from "../src/eval.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

// Latency is wall-clock; pin it so reports can be compared byte for byte.
let clock: ReturnType<typeof spyOn> | undefined;
beforeEach(() => { clock = spyOn(performance, "now").mockReturnValue(1000); });
afterEach(() => clock?.mockRestore());

const STATE = "STATE-SENTINEL-predict", LABEL_SECRET = "review";
const answers: Record<string, Record<string, number>> = {
  [`${STATE}-a`]: { implement: 0.9, review: 0.05, plan: 0.05 },
  [`${STATE}-b`]: { implement: 0.6, review: 0.3, plan: 0.1 },
  [`${STATE}-c`]: { implement: 0.1, review: 0.8, plan: 0.1 },
  [`${STATE}-d`]: { implement: 0.45, review: 0.1, plan: 0.45 },
};
const labelled = [
  { id: "r0", state: `${STATE}-a`, label: "implement", tags: ["ko"] },
  { id: "r1", state: `${STATE}-b`, label: "review", tags: ["ko", "en"] },
  { id: "r2", state: `${STATE}-c`, label: "review" },
  { id: "r3", state: `${STATE}-d`, label: "plan", tags: ["en"] },
  { id: "r4", state: "private", label: "plan", pii: true },
];
const unlabelled = labelled.map(({ label: _label, ...r }) => r);
const labels = labelled.map(r => ({ id: r.id, label: r.label }));
const flipQuestion = { ...question, questionId: "flip.v1", instructions: "Other wording.", options: [...question.options].reverse() };
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const respond = (body: any) => systemOneAnswer(answers[body.state] ?? { implement: 1, review: 0, plan: 0 });

function setup(url: string) {
  const home = tempDir();
  mkdirSync(home, { recursive: true });
  const keyFile = join(home, "key.txt");
  writeFileSync(keyFile, "KEY\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: url, model: "fake-1.0", keyFile, onPrem: false } }, default: "fake" }));
  const files = { q: join(home, "q.json"), flip: join(home, "flip.json"), set: join(home, "set.jsonl"), unl: join(home, "unl.jsonl"), labels: join(home, "labels.jsonl") };
  writeFileSync(files.q, JSON.stringify(question));
  writeFileSync(files.flip, JSON.stringify(flipQuestion));
  writeFileSync(files.set, jsonl(labelled));
  writeFileSync(files.unl, jsonl(unlabelled));
  writeFileSync(files.labels, jsonl(labels));
  const out: string[] = [], err: string[] = [];
  return { home, ...files, out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { ADEC_HOME: home } } };
}

for (const flip of [false, true]) for (const asJson of [false, true]) test(`AC1: predict + score equals eval byte for byte (flip ${flip}, json ${asJson})`, async () => {
  const fake = fakeServer(respond);
  try {
    const s = setup(fake.url), flipArgs = flip ? ["--flip-question", s.flip] : [], json = asJson ? ["--json"] : [];
    const evalRows = join(s.home, "eval-rows.jsonl"), preds = join(s.home, "preds.jsonl"), scored = join(s.home, "scored.jsonl");
    expect(await main(["eval", "--question", s.q, "--set", s.set, "--rows-out", evalRows, ...flipArgs, ...json], s.io)).toBe(EXIT.ok);
    const evalReport = s.out.at(-1)!;
    expect(await main(["predict", "--question", s.q, "--set", s.unl, "--rows-out", preds, ...flipArgs], s.io)).toBe(EXIT.ok);
    expect(await main(["score", "--rows", preds, "--labels", s.labels, "--rows-out", scored, ...json], s.io)).toBe(EXIT.ok);
    expect(s.out.at(-1)!).toBe(evalReport);
    expect(readFileSync(scored, "utf8")).toBe(readFileSync(evalRows, "utf8"));
    expect(await main(["eval", "compare", evalRows, scored, "--seed", "1", "--json"], s.io)).toBe(EXIT.ok);
    expect(JSON.parse(s.out.at(-1)!)).toMatchObject({ diff: 0, aOnly: 0, bOnly: 0 });
    expect(s.err).toEqual([]);
  } finally { fake.stop(); }
});

test("AC1: library predict + score equals evaluate", async () => {
  const fake = fakeServer(respond);
  try {
    const p = provider(fake.url, { onPrem: false, version: "v7" }), key = { key: async () => undefined };
    const want = await evaluate(question, parseRows(jsonl(labelled), question), p, { ...key, perRow: true, flipQuestion });
    const got = await score(await predict(question, unlabelled, p, { ...key, flipQuestion }), labels);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  } finally { fake.stop(); }
});

test("AC2: a predict record never contains a label or state; predict writes no shadow record", async () => {
  const fake = fakeServer(respond);
  try {
    const s = setup(fake.url), preds = join(s.home, "preds.jsonl");
    expect(await main(["predict", "--question", s.q, "--set", s.unl, "--rows-out", preds, "--flip-question", s.flip], s.io)).toBe(EXIT.ok);
    const text = readFileSync(preds, "utf8");
    for (const r of text.trim().split("\n").map(l => JSON.parse(l))) {
      expect(r).not.toHaveProperty("label");
      expect(r).not.toHaveProperty("rowSha256");
      expect(r.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const secret of [STATE, "private", question.instructions, question.options[0]!.description!, "KEY"]) expect(text + s.out.join("\n")).not.toContain(secret);
    expect(() => readFileSync(join(s.home, "shadow"), "utf8")).toThrow();
    // a labelled set row is refused: predict never reads labels
    expect(await main(["predict", "--question", s.q, "--set", s.set, "--rows-out", join(s.home, "x.jsonl")], s.io)).toBe(EXIT.usage);
    expect(s.err.at(-1)).not.toContain(LABEL_SECRET);
  } finally { fake.stop(); }
});

test("AC2: score refuses missing, duplicate and extra ids without printing state or label text", async () => {
  const fake = fakeServer(respond);
  try {
    const s = setup(fake.url), preds = join(s.home, "preds.jsonl");
    expect(await main(["predict", "--question", s.q, "--set", s.unl, "--rows-out", preds], s.io)).toBe(EXIT.ok);
    const bad: [string, unknown[]][] = [
      ["missing", labels.slice(1)],
      ["duplicate", [...labels, labels[0]]],
      ["extra", [...labels, { id: "zz", label: "plan" }]],
      ["not an option", labels.map((l, i) => (i ? l : { ...l, label: "nope" }))],
      ["unknown field", labels.map((l, i) => (i ? l : { ...l, state: STATE }))],
    ];
    for (const [name, rows] of bad) {
      const f = join(s.home, `${name}.jsonl`);
      writeFileSync(f, jsonl(rows));
      expect(`${name}: ${await main(["score", "--rows", preds, "--labels", f], s.io)}`).toBe(`${name}: ${EXIT.usage}`);
      for (const secret of [STATE, "private", "implement", "review", "nope"]) expect(s.err.at(-1)!).not.toContain(secret);
    }
    const dup = join(s.home, "dup-preds.jsonl");
    writeFileSync(dup, readFileSync(preds, "utf8") + readFileSync(preds, "utf8").split("\n")[0] + "\n");
    expect(await main(["score", "--rows", dup, "--labels", s.labels], s.io)).toBe(EXIT.usage);
    expect(s.out).toHaveLength(1);
  } finally { fake.stop(); }
});

test("predict and score library inputs are re-validated", async () => {
  const fake = fakeServer(respond);
  try {
    const p = provider(fake.url), key = { key: async () => undefined };
    await expect(predict(question, [{ state: "s" } as never], p, key)).rejects.toThrow(UsageError);
    await expect(predict(question, [{ id: "a", state: "s" }, { id: "a", state: "t" }], p, key)).rejects.toThrow(UsageError);
    await expect(score([], labels)).rejects.toThrow(UsageError);
    expect(fake.seen).toHaveLength(0);
  } finally { fake.stop(); }
});
