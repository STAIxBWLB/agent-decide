import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { EXIT, main } from "../src/cli.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { fakeServer, question, systemOneAnswer, tempDir } from "./fakes.ts";

const KEY = "SENTINEL-KEY-7f3a";

function setup(url: string, onPrem = true) {
  const home = tempDir();
  mkdirSync(home, { recursive: true });
  const keyFile = join(home, "key.txt");
  writeFileSync(keyFile, `${KEY}\n`);
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: url, model: "fake-1.0", keyFile, onPrem } }, default: "fake" }));
  const q = join(home, "question.json");
  writeFileSync(q, JSON.stringify(question));
  const out: string[] = [], err: string[] = [];
  return { home, q, out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { ADEC_HOME: home } } };
}

test("ask decides (exit 0), abstains (exit 3) and logs to the shadow directory", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.1 }));
  try {
    const s = setup(fake.url);
    expect(await main(["ask", "--question", s.q, "--state", "fix it", "--json"], s.io)).toBe(EXIT.ok);
    const d = JSON.parse(s.out[0]!);
    expect(d.choice).toBe("implement");
    expect(fake.seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(await main(["ask", "--question", s.q, "--state", "fix it", "--min-margin", "0.9"], s.io)).toBe(EXIT.abstained);
    expect(await main(["shadow", "label", d.id, "implement"], s.io)).toBe(EXIT.ok);
    expect(await main(["shadow", "report", "--json"], s.io)).toBe(EXIT.ok);
    expect(JSON.parse(s.out.at(-1)!).questions[0]).toMatchObject({ decisions: 2, labelled: 1, agreement: 1 });
  } finally { fake.stop(); }
});

test("AC6: the key never appears in output, errors or shadow records, including on HTTP errors", async () => {
  const fake = fakeServer(() => new Response(`denied for ${KEY}`, { status: 401 }));
  try {
    const s = setup(fake.url);
    expect(await main(["ask", "--question", s.q, "--state", "x", "--json"], s.io)).toBe(EXIT.abstained);
    expect(await main(["ask", "--question", s.q, "--state", "x"], s.io)).toBe(EXIT.abstained);
    expect(await main(["providers", "--json"], s.io)).toBe(EXIT.ok);
    const shadow = join(s.home, "shadow");
    const logged = readdirSync(shadow).map(f => readFileSync(join(shadow, f), "utf8")).join("");
    for (const text of [...s.out, ...s.err, logged]) expect(text).not.toContain(KEY);
    expect(s.out.join("\n")).toContain("HTTP 401");
  } finally { fake.stop(); }
});

test("usage errors exit 2 and name the fix", async () => {
  const s = setup("http://127.0.0.1:9");
  expect(await main(["ask", "--question", s.q], s.io)).toBe(EXIT.usage);
  expect(s.err.at(-1)).toContain("--state");
  expect(await main(["ask", "--bogus"], s.io)).toBe(EXIT.usage);
  expect(await main(["nope"], s.io)).toBe(EXIT.usage);
  expect(await main(["eval", "--question", s.q, "--set", join(s.home, "missing.jsonl")], s.io)).toBe(EXIT.usage);
});

test("every command in the table is reachable", async () => {
  const s = setup("http://127.0.0.1:9");
  for (const c of COMMANDS) {
    const code = await main([...c.name.split(" "), "--json"], s.io);
    expect([EXIT.ok, EXIT.usage]).toContain(code as never);
    expect(s.err.join("\n")).not.toContain("unknown command");
  }
});


test("#6 AC1: rows-out is exclusive, mode 0600, content-free, ordered and includes skipped rows", async () => {
  const sentinel = "STATE-SENTINEL-never-store";
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.1 }));
  try {
    const s = setup(fake.url, false), set = join(s.home, "set.jsonl"), output = join(s.home, "rows.jsonl");
    writeFileSync(set, [
      { id: "r0", state: sentinel, label: "implement", tags: ["ko"] },
      { id: "r1", state: "private", label: "plan", pii: true },
      { id: "r2", state: sentinel, label: "review" },
    ].map(row => JSON.stringify(row)).join("\n"));
    const args = ["eval", "--question", s.q, "--set", set, "--rows-out", output, "--json"];
    expect(await main(args, s.io)).toBe(EXIT.ok);
    const text = readFileSync(output, "utf8"), rows = text.trim().split("\n").map(line => JSON.parse(line));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(rows.map(r => [r.n, r.id])).toEqual([[0, "r0"], [1, "r1"], [2, "r2"]]);
    expect(rows[1]).toEqual({ v: 1, n: 1, id: "r1", rowSha256: expect.stringMatching(/^[a-f0-9]{64}$/), label: "plan", tags: [], skipped: true });
    for (const content of [text, ...s.out, ...s.err]) for (const secret of [sentinel, KEY, question.instructions, question.options[0]!.description!]) expect(content).not.toContain(secret);
    expect(JSON.parse(s.out[0]!)).not.toHaveProperty("rows");
    expect(fake.seen).toHaveLength(2);
    expect(await main(args, s.io)).toBe(EXIT.usage);
    expect(readFileSync(output, "utf8")).toBe(text);
    expect(fake.seen).toHaveLength(2);
    expect(await main(["eval", "compare", output, output, "--seed", "1", "--json"], s.io)).toBe(EXIT.ok);
    expect(JSON.parse(s.out.at(-1)!)).toMatchObject({ n: 2, accuracyA: 0.5, accuracyB: 0.5, diff: 0, mcnemarP: 1 });
    expect(await main(["eval", "compare", output, output], s.io)).toBe(EXIT.usage);
    expect(s.err.at(-1)).toContain("--seed");
    writeFileSync(join(s.home, "bad.jsonl"), JSON.stringify({ ...rows[0], rowSha256: "f".repeat(64) }) + "\n" + rows.slice(1).map(r => JSON.stringify(r)).join("\n"));
    expect(await main(["eval", "compare", output, join(s.home, "bad.jsonl"), "--seed", "1"], s.io)).toBe(EXIT.usage);
  } finally { fake.stop(); }
});

test("#6 AC3: CLI flip question is wired and validates its option set", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  try {
    const s = setup(fake.url), set = join(s.home, "set.jsonl"), flip = join(s.home, "flip.json");
    writeFileSync(set, JSON.stringify({ state: "s", label: "implement" }));
    writeFileSync(flip, JSON.stringify({ ...question, questionId: "flip.v1", instructions: "Other wording.", options: [...question.options].reverse() }));
    const args = ["eval", "--question", s.q, "--set", set, "--flip-question", flip, "--json"];
    expect(await main(args, s.io)).toBe(EXIT.ok);
    expect(JSON.parse(s.out[0]!)).toMatchObject({ flip: { n: 1, bothAnswered: 1, agreed: 1, agreement: 1 } });
    expect(fake.seen).toHaveLength(2);
    writeFileSync(flip, JSON.stringify(question));
    expect(await main(args, s.io)).toBe(EXIT.usage);
    expect(fake.seen).toHaveLength(2);
  } finally { fake.stop(); }
});


test("review P2: invalid eval input leaves no rows-out file and a corrected retry can use the same path", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  try {
    for (const invalid of ["margin", "flip-id", "flip-options"]) {
      const s = setup(fake.url), set = join(s.home, "set.jsonl"), output = join(s.home, "rows.jsonl"), flip = join(s.home, "flip.json");
      writeFileSync(set, JSON.stringify({ state: "s", label: "implement" }));
      writeFileSync(flip, JSON.stringify(invalid === "flip-id" ? question : { ...question, questionId: "flip.v1", options: [{ id: "implement" }, { id: "other" }] }));
      const args = ["eval", "--question", s.q, "--set", set, "--rows-out", output, "--json"];
      const calls = fake.seen.length;
      expect(await main([...args, ...(invalid === "margin" ? ["--min-margin", "2"] : ["--flip-question", flip])], s.io)).toBe(EXIT.usage);
      expect(existsSync(output)).toBe(false);
      expect(fake.seen).toHaveLength(calls);
      expect(await main(args, s.io)).toBe(EXIT.ok);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ n: 0, skipped: false, choice: "implement" });
      expect(fake.seen).toHaveLength(calls + 1);
    }
  } finally { fake.stop(); }
});

test("review P2: failed evaluation leaves no rows-out file and the identical command succeeds after key repair", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  try {
    const s = setup(fake.url), set = join(s.home, "set.jsonl"), output = join(s.home, "rows.jsonl"), keyFile = join(s.home, "key.txt");
    writeFileSync(set, JSON.stringify({ state: "s", label: "implement" }));
    writeFileSync(keyFile, "invalid key with whitespace");
    const args = ["eval", "--question", s.q, "--set", set, "--rows-out", output, "--json"];
    expect(await main(args, s.io)).toBe(EXIT.usage);
    expect(existsSync(output)).toBe(false);
    expect(fake.seen).toHaveLength(0);
    writeFileSync(keyFile, KEY);
    expect(await main(args, s.io)).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ n: 0, skipped: false, choice: "implement" });
    expect(fake.seen).toHaveLength(1);
  } finally { fake.stop(); }
});


test("rows-out removes its own partial file when writing fails", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  const s = setup(fake.url), set = join(s.home, "set.jsonl"), output = join(s.home, "rows.jsonl");
  writeFileSync(set, JSON.stringify({ state: "s", label: "implement" }));
  const originalOpen = fs.open;
  const opened = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === output && args[1] === "wx") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => { await write("partial"); throw new Error("synthetic disk failure"); };
    }
    return handle;
  });
  try {
    const args = ["eval", "--question", s.q, "--set", set, "--rows-out", output];
    expect(await main(args, s.io)).toBe(EXIT.usage);
    expect(existsSync(output)).toBe(false);
    expect(fake.seen).toHaveLength(1);
    opened.mockRestore();
    expect(await main(args, s.io)).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(output, "utf8"))).toHaveProperty("choice", "implement");
  } finally { opened.mockRestore(); fake.stop(); }
});

test("rows-out exclusive creation preserves a destination created during evaluation", async () => {
  const s = setup("http://127.0.0.1:9"), set = join(s.home, "set.jsonl"), output = join(s.home, "rows.jsonl");
  const fake = fakeServer(() => {
    writeFileSync(output, "concurrent owner's file");
    return systemOneAnswer({ implement: 1, review: 0, plan: 0 });
  });
  writeFileSync(join(s.home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: fake.url, model: "fake-1.0", onPrem: true } } }));
  writeFileSync(set, JSON.stringify({ state: "s", label: "implement" }));
  try {
    expect(await main(["eval", "--question", s.q, "--set", set, "--rows-out", output], s.io)).toBe(EXIT.usage);
    expect(readFileSync(output, "utf8")).toBe("concurrent owner's file");
    expect(fake.seen).toHaveLength(1);
  } finally { fake.stop(); }
});
