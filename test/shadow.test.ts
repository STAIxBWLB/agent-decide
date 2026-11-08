import { expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../src/contract.ts";
import { decide } from "../src/decide.ts";
import { labelOutcome, shadowReport } from "../src/shadow.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

test("AC7: shadow records hold no state, instructions or descriptions, and report agreement from outcomes", async () => {
  const dir = tempDir();
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.8, review: 0.1, plan: 0.1 }));
  try {
    const opts = { shadowDir: dir, key: async () => undefined };
    const secretState = "SECRET-STATE-TEXT student 2026123";
    const a = await decide({ question, state: secretState }, provider(fake.url), opts);
    const b = await decide({ question, state: secretState }, provider(fake.url), opts);
    await decide({ question, state: secretState, minMargin: 0.9 }, provider(fake.url), opts);
    await labelOutcome(dir, a.id, "implement");
    await labelOutcome(dir, b.id, "review");
    const text = readdirSync(dir).map(f => readFileSync(join(dir, f), "utf8")).join("");
    for (const leak of [secretState, "Pick the task class", "write code", "review a change"]) expect(text).not.toContain(leak);
    expect(text).toContain('"stateSha256"');
    expect(text).toContain('"optionCount":3');
    const [r] = await shadowReport(dir);
    expect(r).toEqual({ questionId: "test.triage.v1", decisions: 3, abstained: { low_margin: 1 }, labelled: 2, agreed: 1, agreement: 0.5 });
  } finally { fake.stop(); }
});

test("outcome labels must be an option id or a closed word, for a known decision", async () => {
  const dir = tempDir();
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.8, review: 0.1, plan: 0.1 }));
  try {
    const d = await decide({ question, state: "s" }, provider(fake.url), { shadowDir: dir, key: async () => undefined });
    await expect(labelOutcome(dir, d.id, "nonsense")).rejects.toThrow(UsageError);
    await expect(labelOutcome(dir, "0".repeat(32), "accepted")).rejects.toThrow(UsageError);
    await expect(labelOutcome(dir, "short", "accepted")).rejects.toThrow(UsageError);
    expect((await labelOutcome(dir, d.id, "accepted")).label).toBe("accepted");
  } finally { fake.stop(); }
});

test("review r2: a torn last line does not swallow the next records", async () => {
  const dir = tempDir();
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.8, review: 0.1, plan: 0.1 }));
  try {
    const opts = { shadowDir: dir, key: async () => undefined };
    await decide({ question, state: "s" }, provider(fake.url), opts);
    const file = join(dir, readdirSync(dir)[0]!);
    appendFileSync(file, '{"v":1,"kind":"decision","id":"to'); // crash mid-write
    const d = await decide({ question, state: "s" }, provider(fake.url), opts);
    await labelOutcome(dir, d.id, "implement");
    const [r] = await shadowReport(dir);
    expect(r).toMatchObject({ decisions: 2, labelled: 1, agreement: 1 });
  } finally { fake.stop(); }
});
