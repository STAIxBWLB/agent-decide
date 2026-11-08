import { expect, test } from "bun:test";
import { UsageError } from "../src/contract.ts";
import { ece, evaluate, macroF1, parseRows } from "../src/eval.ts";
import { fakeServer, provider, question, systemOneAnswer } from "./fakes.ts";

// The fake answers by the state text, so every metric below has a hand-computed value.
const answers: Record<string, Record<string, number>> = {
  a: { implement: 0.9, review: 0.05, plan: 0.05 }, // correct (label implement)
  b: { implement: 0.6, review: 0.3, plan: 0.1 },   // wrong (label review)
  c: { implement: 0.1, review: 0.8, plan: 0.1 },   // correct (label review)
  d: { implement: 0.45, review: 0.1, plan: 0.45 }, // tie: margin 0, abstains under min margin 0.05 (label plan)
};
const set = [
  { state: "a", label: "implement" }, { state: "b", label: "review" }, { state: "c", label: "review" }, { state: "d", label: "plan" },
  { state: "p", label: "plan", pii: true },
].map(r => JSON.stringify(r)).join("\n");

test("AC8: eval reports accuracy, coverage, macro-F1, ECE, Brier and latency on a known set", async () => {
  const fake = fakeServer(body => systemOneAnswer(answers[body.state]!));
  try {
    const rows = parseRows(set, question);
    const r = await evaluate(question, rows, provider(fake.url, { onPrem: false }), { key: async () => undefined, minMargin: 0.05 });
    expect(r).toMatchObject({ n: 5, skipped: 1, answered: 3, abstained: { low_margin: 1 } });
    expect(fake.seen).toHaveLength(4);
    expect(r.accuracy).toBeCloseTo(2 / 3);
    expect(r.coverage).toBeCloseTo(3 / 4);
    // pairs: implement/implement, implement/review, review/review -> F1 implement 2/3, review 2/3
    expect(r.macroF1).toBeCloseTo(2 / 3);
    // top probabilities 0.9 (correct), 0.6 (wrong), 0.8 (correct), 0.45 (wrong: implement chosen first on the tie)
    expect(r.ece).toBeCloseTo((Math.abs(1 - 0.9) + Math.abs(0 - 0.6) + Math.abs(1 - 0.8) + Math.abs(0 - 0.45)) / 4);
    const brier = [
      0.1 ** 2 + 0.05 ** 2 + 0.05 ** 2,
      0.6 ** 2 + 0.7 ** 2 + 0.1 ** 2,
      0.1 ** 2 + 0.2 ** 2 + 0.1 ** 2,
      0.45 ** 2 + 0.1 ** 2 + 0.55 ** 2,
    ];
    expect(r.brier).toBeCloseTo(brier.reduce((s, x) => s + x, 0) / 4);
    expect(r.latencyMs.p50).not.toBeNull();
    expect(r.latencyMs.p95).not.toBeNull();
  } finally { fake.stop(); }
});

test("eval rows are validated: labels must be option ids and fields are closed", () => {
  expect(() => parseRows('{"state":"a","label":"other"}', question)).toThrow(UsageError);
  expect(() => parseRows('{"state":"a","label":"plan","text":"x"}', question)).toThrow(UsageError);
  expect(() => parseRows("not json", question)).toThrow(UsageError);
});

test("ECE and macro-F1 edge cases", () => {
  expect(ece([])).toBeNull();
  expect(ece([{ confidence: 1, correct: true }])).toBe(0);
  expect(macroF1([])).toBeNull();
  expect(macroF1([{ predicted: "a", label: "b" }])).toBe(0);
});

test("review F5: calibration uses the decision's tie rule with numeric option ids", async () => {
  const q = { questionId: "num.v1", instructions: "x", options: [{ id: "2" }, { id: "1" }] };
  const fake = fakeServer(() => Response.json({ answers: { decision: { type: "choice", choice: "2", probabilities: { "2": 0.5, "1": 0.5 } } } }));
  try {
    const r = await evaluate(q, parseRows('{"state":"s","label":"2"}', q), provider(fake.url), { key: async () => undefined });
    expect(r.accuracy).toBe(1);
    expect(r.ece).toBeCloseTo(0.5); // confidence 0.5, correct
  } finally { fake.stop(); }
});
