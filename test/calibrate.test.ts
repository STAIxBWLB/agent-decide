import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendFit, calibrate, fitThreshold, loadFits, modelsReport, temper } from "../src/calibrate.ts";
import { EXIT, main } from "../src/cli.ts";
import { parseConfig } from "../src/config.ts";
import { UsageError } from "../src/contract.ts";
import { decide } from "../src/decide.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

const ids = question.options.map(o => o.id);
const noKey = { key: async () => undefined };

/** Seeded synthetic set: labels drawn from softmax(z); the fake decider reports softmax(2z), so the true temperature is 2. */
function synthetic(n: number) {
  let seed = 20261108;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const softmax = (z: number[]) => { const e = z.map(Math.exp), s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
  const table = new Map<string, Record<string, number>>(), rows: { state: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const z = ids.map(() => (rand() - 0.5) * 8);
    const q = softmax(z), reported = softmax(z.map(x => 2 * x));
    let u = rand(), label = ids[ids.length - 1]!;
    for (let k = 0; k < ids.length; k++) { u -= q[k]!; if (u <= 0) { label = ids[k]!; break; } }
    table.set(`row ${i}`, Object.fromEntries(ids.map((id, k) => [id, reported[k]!])));
    rows.push({ state: `row ${i}`, label });
  }
  return { table, rows };
}

test("AC5: calibrate recovers a known temperature within 10% and reports held-out raw and calibrated metrics", async () => {
  const { table, rows } = synthetic(3000);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state)!));
  try {
    const fit = await calibrate(question, rows, provider(fake.url), { ...noKey, targetAccuracy: 0.8 });
    expect(Math.abs(fit.temperature - 2) / 2).toBeLessThan(0.1);
    expect(fit.n).toBe(3000);
    expect(fit.metrics.raw.n).toBe(fit.metrics.calibrated.n);
    expect(fit.metrics.raw.n).toBeGreaterThan(300);
    expect(fit.metrics.calibrated.ece).toBeLessThan(fit.metrics.raw.ece);
    expect(fit.metrics.calibrated.coverage).toBeLessThan(1);
  } finally { fake.stop(); }
});

test("AC5: fewer than 50 answered rows refuse to fit, and nothing is written", async () => {
  const { table, rows } = synthetic(49);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state)!));
  try {
    await expect(calibrate(question, rows, provider(fake.url), noKey)).rejects.toThrow(UsageError);
  } finally { fake.stop(); }
});

test("AC5: the CLI previews without --confirm and appends exactly one record with it", async () => {
  const { table, rows } = synthetic(200);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state)!));
  try {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: fake.url, model: "fake-1.0", onPrem: true } } }));
    writeFileSync(join(home, "q.json"), JSON.stringify(question));
    writeFileSync(join(home, "set.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const out: string[] = [], io = { out: (s: string) => out.push(s), err: () => {}, env: { ADEC_HOME: home } };
    const args = ["calibrate", "--question", join(home, "q.json"), "--set", join(home, "set.jsonl")];
    expect(await main(args, io)).toBe(EXIT.ok);
    expect(out.at(-1)).toContain("preview only");
    expect(existsSync(join(home, "calibration", "fits.jsonl"))).toBe(false);
    expect(await main([...args, "--confirm", "--json"], io)).toBe(EXIT.ok);
    expect(JSON.parse(out.at(-1)!).saved).toBe(true);
    expect(readFileSync(join(home, "calibration", "fits.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(await loadFits(home)).toHaveLength(1);
  } finally { fake.stop(); }
});

test("AC6: a fit applies only when its full key matches; models shows stale otherwise", async () => {
  const { table, rows } = synthetic(200);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state) ?? { implement: 0.6, review: 0.3, plan: 0.1 }));
  try {
    const home = tempDir();
    const p = provider(fake.url, { version: "2026-11" });
    await appendFit(home, await calibrate(question, rows, p, noKey));
    const fits = await loadFits(home);
    const ask = (prov: typeof p) => decide({ question, state: "row 1" }, prov, { shadowDir: null, fits, ...noKey });
    const applied = await ask(p);
    expect(applied.calibration?.questionId).toBe(question.questionId);
    const expected = temper(table.get("row 1")!, fits[0]!.temperature);
    for (const id of ids) expect(applied.probabilities[id]!).toBeCloseTo(expected[id]!, 9);
    for (const changed of [{ model: "fake-1.1" }, { version: "2026-12" }, { kind: "logits" as const }, { endpoint: `${fake.url}/other` }]) {
      expect((await ask({ ...p, ...changed })).calibration).toBeUndefined();
    }
    expect((await decide({ question: { ...question, questionId: "other.v1" }, state: "row 1" }, p, { shadowDir: null, fits, ...noKey })).calibration).toBeUndefined();
    const config = parseConfig({ providers: { fake: { kind: "systemone", endpoint: fake.url, model: "fake-1.0", version: "2026-11", onPrem: true } } });
    expect(modelsReport(config, fits)[0]!.fits[0]!.status).toBe("fitted");
    const moved = parseConfig({ providers: { fake: { kind: "systemone", endpoint: fake.url, model: "fake-1.1", version: "2026-11", onPrem: true } } });
    expect(modelsReport(moved, fits)[0]!.fits[0]!.status).toBe("stale");
  } finally { fake.stop(); }
});

test("an explicit minMargin wins over the fit's threshold; a torn fits line is skipped", async () => {
  const { table, rows } = synthetic(200);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state)!));
  try {
    const home = tempDir();
    const p = provider(fake.url);
    await appendFit(home, { ...(await calibrate(question, rows, p, noKey)), minMargin: 1 });
    writeFileSync(join(home, "calibration", "fits.jsonl"), `${readFileSync(join(home, "calibration", "fits.jsonl"), "utf8")}{"v":1,"torn`);
    const fits = await loadFits(home);
    expect(fits).toHaveLength(1);
    expect((await decide({ question, state: "row 2" }, p, { shadowDir: null, fits, ...noKey })).reason).toBe("low_margin");
    expect((await decide({ question, state: "row 2", minMargin: 0 }, p, { shadowDir: null, fits, ...noKey })).abstain).toBe(false);
  } finally { fake.stop(); }
});

test("review: a fit threshold of 1 always abstains, even on a certain answer; an unreadable fits file is an error, not no fits", async () => {
  const { table, rows } = synthetic(200);
  const fake = fakeServer(body => systemOneAnswer(table.get(body.state) ?? { implement: 1, review: 0, plan: 0 }));
  try {
    const home = tempDir(), p = provider(fake.url);
    await appendFit(home, { ...(await calibrate(question, rows, p, noKey)), minMargin: 1 });
    const fits = await loadFits(home);
    const d = await decide({ question, state: "certain" }, p, { shadowDir: null, fits, ...noKey });
    expect(d).toMatchObject({ margin: 1, abstain: true, reason: "low_margin", choice: null });
    chmodSync(join(home, "calibration", "fits.jsonl"), 0o000);
    try { await expect(loadFits(home)).rejects.toThrow(UsageError); }
    finally { chmodSync(join(home, "calibration", "fits.jsonl"), 0o600); }
    expect(await loadFits(tempDir())).toEqual([]);
    // Unknown fields make a record foreign: refused by appendFit (before any write) and skipped by loadFits.
    const extra = { ...fits[0]!, extra: 1 } as never;
    const empty = tempDir();
    await expect(appendFit(empty, extra)).rejects.toThrow(UsageError);
    expect(existsSync(join(empty, "calibration"))).toBe(false);
    await expect(appendFit(empty, { ...fits[0]!, metrics: { ...fits[0]!.metrics, raw: { ...fits[0]!.metrics.raw, x: 1 } } } as never)).rejects.toThrow(UsageError);
    writeFileSync(join(home, "calibration", "fits.jsonl"), `${JSON.stringify(extra)}\n`);
    expect(await loadFits(home)).toEqual([]);
  } finally { fake.stop(); }
});

test("threshold: smallest margin reaching the target, ties kept together, 1 when unreachable", () => {
  const pt = (implement: number, review: number, label: string) => ({ probabilities: { implement, review, plan: 1 - implement - review }, label });
  // margins 0.1 (wrong), 0.5 (right), 0.5 (wrong), 0.9 (right)
  const points = [pt(0.5, 0.4, "review"), pt(0.7, 0.2, "implement"), pt(0.7, 0.2, "review"), pt(0.95, 0.05, "implement")];
  expect(fitThreshold(question, points, 0.5)).toBe(0);
  expect(fitThreshold(question, points, 0.6)).toBeCloseTo(0.5);
  expect(fitThreshold(question, points, 0.9)).toBeCloseTo(0.9);
  expect(fitThreshold(question, [pt(0.6, 0.3, "review")], 0.9)).toBe(1);
});

test("config: version and sha256 are pinned and validated", () => {
  const base = { kind: "systemone", endpoint: "https://d.example", model: "kev-4b", onPrem: false };
  expect(parseConfig({ providers: { a: { ...base, version: "2026-10", sha256: "a".repeat(64) } } }).providers.a).toMatchObject({ version: "2026-10", sha256: "a".repeat(64) });
  for (const bad of [{ version: "latest" }, { version: "v-latest" }, { version: "" }, { version: "a b" }, { sha256: "A".repeat(64) }, { sha256: "abc" }])
    expect(() => parseConfig({ providers: { a: { ...base, ...bad } } })).toThrow(UsageError);
});
