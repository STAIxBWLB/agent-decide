import { createHash } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkProvider, type Config, type ProviderConfig } from "./config.ts";
import { parseQuestion, topTwo, unknownFields, UsageError, type Question } from "./contract.ts";
import { decide, type DecideOptions } from "./decide.ts";
import { brierScore, ece, parseRow, type EvalRow } from "./eval.ts";
import { readTextBounded } from "./io.ts";

/** One temperature and margin threshold for (questionId, provider name, kind, model, version, endpoint). Spec #4. */
export interface Fit {
  v: 1; questionId: string; provider: string; kind: string; model: string; version?: string; endpointSha256: string;
  method: "temperature"; temperature: number; minMargin: number; targetAccuracy: number; fittedAt: string;
  n: number; setSha256: string; metrics: { raw: SplitMetrics; calibrated: SplitMetrics };
}
/** Held-out metrics; coverage and selective accuracy are at the fitted threshold (raw: threshold 0). */
export interface SplitMetrics { n: number; accuracy: number; coverage: number; selectiveAccuracy: number | null; ece: number; brier: number }

export const MIN_ANSWERED = 50;
const T_MIN = 0.05, T_MAX = 20, FITS_BYTES = 16 * 1024 * 1024;

export function fitsFile(home: string): string { return join(home, "calibration", "fits.jsonl"); }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** p_i ∝ p_i^(1/T), computed in log space; a zero stays zero. */
export function temper(probabilities: Record<string, number>, temperature: number): Record<string, number> {
  const logs = Object.entries(probabilities).map(([id, p]) => [id, p > 0 ? Math.log(p) / temperature : -Infinity] as const);
  const max = Math.max(...logs.map(([, l]) => l));
  const exp = logs.map(([id, l]) => [id, Number.isFinite(l) ? Math.exp(l - max) : 0] as const);
  const sum = exp.reduce((s, [, e]) => s + e, 0);
  return Object.fromEntries(exp.map(([id, e]) => [id, e / sum]));
}

interface Point { probabilities: Record<string, number>; label: string }

function nll(points: Point[], t: number): number {
  return points.reduce((s, p) => s - Math.log(Math.max(1e-12, temper(p.probabilities, t)[p.label] ?? 0)), 0) / points.length;
}

/** Golden-section search on log T in [0.05, 20]; NLL in log T is unimodal for temperature scaling. */
export function fitTemperature(points: Point[]): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = Math.log(T_MIN), b = Math.log(T_MAX);
  let c = b - g * (b - a), d = a + g * (b - a), fc = nll(points, Math.exp(c)), fd = nll(points, Math.exp(d));
  for (let i = 0; i < 80; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = nll(points, Math.exp(c)); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = nll(points, Math.exp(d)); }
  }
  return Math.exp((a + b) / 2);
}

/** The smallest margin whose answered rows reach the target accuracy; none reaches it -> 1, which decide treats as always abstain. */
export function fitThreshold(question: Question, points: Point[], targetAccuracy: number): number {
  const scored = points.map(p => { const top = topTwo(question, p.probabilities); return { margin: top.margin, correct: top.choice === p.label }; })
    .sort((x, y) => x.margin - y.margin);
  let correct = scored.filter(s => s.correct).length;
  for (let i = 0; i < scored.length; i++) {
    // Rows i.. are answered at threshold scored[i].margin (ties stay together: skip to the first of equal margins).
    if (i > 0 && scored[i]!.margin === scored[i - 1]!.margin) { correct -= scored[i]!.correct ? 1 : 0; continue; }
    if (correct / (scored.length - i) >= targetAccuracy) return i === 0 ? 0 : scored[i]!.margin;
    correct -= scored[i]!.correct ? 1 : 0;
  }
  return 1;
}

function metrics(question: Question, points: Point[], minMargin: number): SplitMetrics {
  const scored = points.map(p => { const top = topTwo(question, p.probabilities); return { ...top, correct: top.choice === p.label, p }; });
  const answered = scored.filter(s => s.margin >= minMargin);
  return {
    n: points.length,
    accuracy: scored.filter(s => s.correct).length / points.length,
    coverage: answered.length / points.length,
    selectiveAccuracy: answered.length ? answered.filter(s => s.correct).length / answered.length : null,
    ece: ece(scored.map(s => ({ confidence: s.p.probabilities[s.choice] ?? 0, correct: s.correct }))) ?? 0,
    brier: points.reduce((sum, p) => sum + brierScore(question, p.probabilities, p.label), 0) / points.length,
  };
}

/** The fit key without the questionId; every field must match for a fit to apply. */
function keyOf(provider: ProviderConfig) {
  return { provider: provider.name, kind: provider.kind, model: provider.model, ...(provider.version === undefined ? {} : { version: provider.version }), endpointSha256: sha(provider.endpoint) };
}

export function fitMatches(fit: Fit, questionId: string, provider: ProviderConfig): boolean {
  const key = keyOf(provider);
  return fit.questionId === questionId && fit.provider === key.provider && fit.kind === key.kind && fit.model === key.model
    && fit.version === key.version && fit.endpointSha256 === key.endpointSha256;
}

/** The newest matching fit (fits are in append order). */
export function findFit(fits: readonly Fit[], questionId: string, provider: ProviderConfig): Fit | undefined {
  for (let i = fits.length - 1; i >= 0; i--) if (fitMatches(fits[i]!, questionId, provider)) return fits[i];
  return undefined;
}

const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Validate one fit record (a fits.jsonl line or a library caller's object). */
export function parseFit(raw: unknown): Fit {
  const f = raw as Fit;
  const split = (m: unknown) => { const s = m as SplitMetrics; return typeof m === "object" && m !== null && Number.isInteger(s.n) && num(s.accuracy, 0, 1) && num(s.coverage, 0, 1) && (s.selectiveAccuracy === null || num(s.selectiveAccuracy, 0, 1)) && num(s.ece, 0, 1) && num(s.brier, 0, 2); };
  const ok = typeof raw === "object" && raw !== null && f.v === 1 && f.method === "temperature"
    && typeof f.questionId === "string" && typeof f.provider === "string" && typeof f.kind === "string" && typeof f.model === "string"
    && (f.version === undefined || typeof f.version === "string") && typeof f.endpointSha256 === "string" && /^[0-9a-f]{64}$/.test(f.endpointSha256)
    && num(f.temperature, T_MIN, T_MAX) && num(f.minMargin, 0, 1) && num(f.targetAccuracy, 0, 1) && typeof f.fittedAt === "string" && !Number.isNaN(Date.parse(f.fittedAt))
    && Number.isInteger(f.n) && f.n >= MIN_ANSWERED && typeof f.setSha256 === "string" && typeof f.metrics === "object" && f.metrics !== null && split(f.metrics.raw) && split(f.metrics.calibrated);
  if (!ok) throw new UsageError("calibration fit: not a fit record written by adec calibrate; refit with adec calibrate --confirm");
  return f;
}

/** Fits in append order; a torn or foreign line is skipped, a missing file is no fits. */
export async function loadFits(home: string): Promise<Fit[]> {
  if (typeof home !== "string" || !home) throw new UsageError("loadFits: give the ADEC_HOME directory");
  // Only a missing file is "no fits"; an unreadable one must not silently switch calibration off.
  try { await stat(fitsFile(home)); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new UsageError(`calibration fits: cannot read ${fitsFile(home)} (${(e as NodeJS.ErrnoException).code ?? "error"}); fix its permissions or move it away`);
  }
  const text = await readTextBounded(fitsFile(home), FITS_BYTES, "calibration fits");
  const fits: Fit[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { fits.push(parseFit(JSON.parse(line))); } catch { /* skipped */ }
  }
  return fits;
}

export async function appendFit(home: string, fit: Fit): Promise<void> {
  const file = fitsFile(home);
  await mkdir(join(home, "calibration"), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(parseFit(fit))}\n`, { mode: 0o600 });
}

export function parseTargetAccuracy(raw: unknown): number {
  if (raw === undefined) return 0.9;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1) throw new UsageError("target accuracy: give a number above 0 and at most 1, for example 0.9");
  return n;
}

/**
 * Run the provider over a labelled set and fit a temperature and threshold. Writes nothing (the CLI appends with --confirm).
 * Deterministic 70/30 split by row hash: fit on 70%, report on 30%.
 */
export async function calibrate(question: Question, rows: EvalRow[], provider: ProviderConfig, options: Pick<DecideOptions, "key"> & { targetAccuracy?: number; now?: Date } = {}): Promise<Fit> {
  question = parseQuestion(question);
  const ids = new Set(question.options.map(o => o.id));
  if (!Array.isArray(rows)) throw new UsageError("calibrate: rows must be an array");
  rows = rows.map((r, i) => parseRow(r, ids, `rows[${i}]`));
  provider = checkProvider(provider);
  if (typeof options !== "object" || options === null) throw new UsageError("calibrate options: give an object");
  const unknown = Object.keys(options).filter(k => !["key", "targetAccuracy", "now"].includes(k));
  if (unknown.length) throw new UsageError(`calibrate options: ${unknownFields(unknown, ["key", "targetAccuracy", "now"])}`);
  if (options.key !== undefined && typeof options.key !== "function") throw new UsageError("calibrate options.key: give a function or leave it out");
  if (options.now !== undefined && !(options.now instanceof Date && !Number.isNaN(options.now.getTime()))) throw new UsageError("calibrate options.now: give a valid Date");
  const targetAccuracy = parseTargetAccuracy(options.targetAccuracy);

  const fit: Point[] = [], held: Point[] = [];
  for (const row of rows) {
    if (row.pii && !provider.onPrem) continue;
    const d = await decide({ question, state: row.state }, provider, { shadowDir: null, ...(options.key ? { key: options.key } : {}) });
    if (!Object.keys(d.probabilities).length) continue;
    // First 4 bytes of the row hash as a fraction: identical rows land on the same side.
    (parseInt(sha(JSON.stringify([row.state, row.label])).slice(0, 8), 16) / 2 ** 32 < 0.7 ? fit : held).push({ probabilities: d.probabilities, label: row.label });
  }
  const answered = fit.length + held.length;
  if (answered < MIN_ANSWERED || !fit.length || !held.length)
    throw new UsageError(`calibrate: ${answered} rows got probabilities; at least ${MIN_ANSWERED} are needed, split across fit and report; add labelled rows or check the provider with adec ask`);
  const temperature = fitTemperature(fit);
  const tempered = (ps: Point[]) => ps.map(p => ({ ...p, probabilities: temper(p.probabilities, temperature) }));
  const minMargin = fitThreshold(question, tempered(fit), targetAccuracy);
  return {
    v: 1, questionId: question.questionId, ...keyOf(provider), method: "temperature", temperature, minMargin, targetAccuracy,
    fittedAt: (options.now ?? new Date()).toISOString(), n: answered,
    setSha256: sha(rows.map(r => JSON.stringify([r.state, r.label, r.pii ?? false])).join("\n")),
    metrics: { raw: metrics(question, held, 0), calibrated: metrics(question, tempered(held), minMargin) },
  };
}

export interface ModelEntry {
  name: string; kind: string; model: string; version?: string; sha256?: string; onPrem: boolean; default: boolean;
  fits: { questionId: string; status: "fitted" | "stale"; fittedAt: string; temperature: number; minMargin: number }[];
}

/** The registry view: providers plus, per questionId, the newest fit under the provider's name and whether it still applies. */
export function modelsReport(config: Config, fits: readonly Fit[]): ModelEntry[] {
  return Object.values(config.providers).map(p => {
    const newest = new Map<string, Fit>();
    for (const f of fits) if (f.provider === p.name) newest.set(f.questionId, f);
    return {
      name: p.name, kind: p.kind, model: p.model, ...(p.version === undefined ? {} : { version: p.version }), ...(p.sha256 === undefined ? {} : { sha256: p.sha256 }),
      onPrem: p.onPrem, default: p.name === config.default,
      fits: [...newest.values()].sort((a, b) => a.questionId.localeCompare(b.questionId)).map(f => {
        // A newer stale fit can hide an older matching one; report the one that applies when there is one.
        const applied = findFit(fits, f.questionId, p);
        const shown = applied ?? f;
        return { questionId: f.questionId, status: applied ? "fitted" as const : "stale" as const, fittedAt: shown.fittedAt, temperature: shown.temperature, minMargin: shown.minMargin };
      }),
    };
  });
}
