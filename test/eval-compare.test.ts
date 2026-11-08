import { expect, test } from "bun:test";
import { compareRows, parseResultRows, type EvalRowResult } from "../src/eval.ts";
import { UsageError } from "../src/contract.ts";

function row(n: number, correct: boolean, tags = ["ko"]): Extract<EvalRowResult, { skipped: false }> {
  const choice = correct ? "yes" : "no";
  return { v: 1, n, id: `row-${n}`, rowSha256: n.toString(16).padStart(64, "0"), label: "yes", tags,
    skipped: false, choice, abstain: false, reason: "ok", margin: 1, top: choice,
    probabilities: { yes: Number(correct), no: Number(!correct) }, latencyMs: 1 };
}
const a = Array.from({ length: 8 }, (_, n) => row(n, n < 2));
const b = Array.from({ length: 8 }, (_, n) => row(n, n === 0 || (n >= 2 && n <= 5)));

test("AC4: paired counts, abstentions-as-wrong, accuracies, exact McNemar and slices", async () => {
  const r = await compareRows(a, b, { seed: 123 });
  expect(r).toMatchObject({ n: 8, bothCorrect: 1, aOnly: 1, bOnly: 4, bothWrong: 2,
    accuracyA: 2 / 8, accuracyB: 5 / 8, diff: 3 / 8, mcnemarP: 0.375, agreement: 3 / 8 });
  expect(r.slices.ko).toEqual({ n: 8, accuracyA: 2 / 8, accuracyB: 5 / 8, diff: 3 / 8 });
  expect(r.bootstrap.resamples).toBe(2000);
  const abstention: EvalRowResult = { ...row(0, true), skipped: false, choice: null, abstain: true, reason: "low_margin" };
  expect(await compareRows([abstention], [row(0, true)], { seed: 1 })).toMatchObject({ aOnly: 0, bOnly: 1, accuracyA: 0, agreement: 0, mcnemarP: 1 });
  expect(await compareRows([row(0, true)], [row(0, true)], { seed: 1 })).toMatchObject({ mcnemarP: 1, diff: 0 });
});

test("AC4: seeded paired bootstrap is repeatable and another seed changes the interval", async () => {
  const first = await compareRows(a, b, { seed: 123, resamples: 17 });
  expect((await compareRows(a, b, { seed: 123, resamples: 17 })).bootstrap).toEqual(first.bootstrap);
  const second = await compareRows(a, b, { seed: 99, resamples: 17 });
  expect([first.bootstrap.lo, first.bootstrap.hi]).not.toEqual([second.bootstrap.lo, second.bootstrap.hi]);
  // Golden interval binds the documented PRNG, paired sampling and nearest-rank percentile convention.
  expect(first.bootstrap).toEqual({ seed: 123, resamples: 17, lo: 0, hi: 0.625 });
});

test("AC4: reject identity mismatches and malformed or content-bearing row results", async () => {
  for (const patch of [{ n: 2 }, { rowSha256: "f".repeat(64) }, { id: "different" }, { label: "no" }, { tags: [] }]) {
    await expect(compareRows(a, [{ ...b[0]!, ...patch }, ...b.slice(1)], { seed: 1 })).rejects.toThrow(UsageError);
  }
  await expect(compareRows(a, b.slice(1), { seed: 1 })).rejects.toThrow(UsageError);
  for (const patch of [{ state: "SENTINEL" }, { probabilities: { yes: 2, no: -1 } }, { reason: "SENTINEL" }, { top: "other" }, { margin: 0.1 }, { latencyMs: -1 }, { skipped: true }]) {
    const raw = { ...a[0]!, ...patch };
    expect(() => parseResultRows(JSON.stringify(raw))).toThrow(UsageError);
    await expect(compareRows([raw as EvalRowResult], [b[0]!], { seed: 1 })).rejects.toThrow(UsageError);
  }
});

test("compare excludes pairs skipped on either side, preserves empty/null metrics and validates options", async () => {
  const skipped: EvalRowResult = { v: 1, n: 0, id: "row-0", rowSha256: "0".repeat(64), label: "yes", tags: ["ko"], skipped: true };
  const r = await compareRows([skipped], [row(0, true)], { seed: 0 });
  expect(r).toMatchObject({ n: 0, accuracyA: null, accuracyB: null, diff: null, agreement: null, mcnemarP: 1, bootstrap: { lo: null, hi: null }, slices: {} });
  for (const options of [{}, { seed: -1 }, { seed: 0.1 }, { seed: 4294967296 }, { seed: NaN }, { seed: 1, resamples: 0 }, { seed: 1, resamples: null }, { seed: 1, extra: true }, null]) {
    await expect(compareRows(a, b, options as never)).rejects.toThrow(UsageError);
  }
});
