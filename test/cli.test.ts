import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
