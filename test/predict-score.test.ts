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

test("score errors name the record as a prediction record and give a next step, without state, label or field values", async () => {
  const fake = fakeServer(respond);
  try {
    const p = provider(fake.url, { onPrem: true });
    const records = await predict(question, unlabelled, p);
    const cases: [unknown[], unknown[], RegExp][] = [
      [records, labels.slice(1), /no label for this id; add it to the labels file$/],
      [records, [...labels, { id: "zz", label: "plan" }], /label id\(s\) have no prediction record; re-run adec predict on the full set or drop those labels$/],
      [[records[0], { ...records[1], run: { ...records[1]!.run, model: "other" } }], labels.slice(0, 2), /differs from record 0; score one adec predict output at a time$/],
      [[{ ...records[0], stateSha256: "x" }], labels.slice(0, 1), /stateSha256 must be a sha256; re-run adec predict, the records were edited or truncated$/],
      [[{ ...records[0], rowSha256ByOption: { implement: "x" } }], labels.slice(0, 1), /sha256 per option id; re-run adec predict, the records were edited or truncated$/],
      [[{ ...records[0], latencyMs: -1 }], labels.slice(0, 1), /^prediction record 0/],
    ];
    for (const [rows, l, want] of cases) {
      const e = await score(rows as never, l as never).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(UsageError);
      const msg = (e as Error).message;
      expect(msg).toMatch(want);
      expect(msg).not.toContain("eval result row");
      for (const secret of [STATE, "implement", "review", "plan"]) expect(msg).not.toContain(secret);
    }
  } finally { fake.stop(); }
});

test("digit-only option ids: predict + score equals eval byte for byte", async () => {
  // Property order puts "1", "2", "3" before question order; these values make the Brier sum order-sensitive.
  // Row a alone (slice t) is order-sensitive: summing Brier in question order 3,1,2 gives 1.3734, in property order
  // 1,2,3 (the order a record's rowSha256ByOption keeps) 1.3734000000000002. Before the fix eval and score differed here.
  const digits = { questionId: "digits.v1", instructions: "Pick one.", options: [{ id: "3" }, { id: "1" }, { id: "2" }] };
  const probs: Record<string, Record<string, number>> = {
    a: { "3": 0.78, "1": 0.13, "2": 0.09 }, b: { "3": 0.1, "1": 0.3, "2": 0.6 }, c: { "3": 0.7, "1": 0.2, "2": 0.1 },
  };
  const fake = fakeServer((body: any) => systemOneAnswer(probs[body.state]!));
  try {
    const rows = [{ id: "a", state: "a", label: "1", tags: ["t"] }, { id: "b", state: "b", label: "3" }, { id: "c", state: "c", label: "3" }];
    const p = provider(fake.url, { onPrem: true });
    const evaluated = await evaluate(digits, rows, p, { perRow: true });
    const scored = await score(await predict(digits, rows.map(({ label: _l, ...r }) => r), p), rows.map(r => ({ id: r.id, label: r.label })));
    expect(JSON.stringify(scored)).toBe(JSON.stringify(evaluated));
  } finally { fake.stop(); }
});
