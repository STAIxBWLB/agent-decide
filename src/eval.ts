import { checkProvider, type ProviderConfig } from "./config.ts";
import { parseMinMargin, parseQuestion, topTwo, unknownFields, UsageError, type Question } from "./contract.ts";
import { decide, type DecideOptions } from "./decide.ts";

export interface EvalRow { state: string; label: string; pii?: boolean }
export interface EvalReport {
  questionId: string; provider: string; model: string;
  n: number; skipped: number; answered: number; abstained: Record<string, number>;
  accuracy: number | null; coverage: number | null; macroF1: number | null; ece: number | null; brier: number | null;
  latencyMs: { p50: number | null; p95: number | null };
}

/** One row check for the CLI file reader and the library entry point alike. */
export function parseRow(raw: unknown, ids: Set<string>, where: string): EvalRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${where}: expected an object`);
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter(k => !["id", "state", "label", "pii"].includes(k));
  if (unknown.length) throw new UsageError(`${where}: ${unknownFields(unknown, ["id", "state", "label", "pii"])}`);
  if (typeof r.state !== "string") throw new UsageError(`${where}: state must be a string`);
  if (typeof r.label !== "string" || !ids.has(r.label)) throw new UsageError(`${where}: label must be one of the question's option ids`);
  if (r.pii !== undefined && typeof r.pii !== "boolean") throw new UsageError(`${where}: pii must be true or false`);
  return { state: r.state, label: r.label, ...(r.pii ? { pii: true } : {}) };
}

export function parseRows(text: string, question: Question): EvalRow[] {
  question = parseQuestion(question);
  const ids = new Set(question.options.map(o => o.id));
  const rows: EvalRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new UsageError(`set line ${i + 1}: not valid JSON`); }
    rows.push(parseRow(raw, ids, `set line ${i + 1}`));
  });
  return rows;
}

/** Nearest-rank percentile. */
function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function ece(points: { confidence: number; correct: boolean }[], bins = 10): number | null {
  if (!points.length) return null;
  const n = Array(bins).fill(0), conf = Array(bins).fill(0), acc = Array(bins).fill(0);
  for (const p of points) {
    const b = Math.min(bins - 1, Math.floor(p.confidence * bins));
    n[b]++; conf[b] += p.confidence; acc[b] += p.correct ? 1 : 0;
  }
  let total = 0;
  for (let b = 0; b < bins; b++) if (n[b]) total += (n[b] / points.length) * Math.abs(acc[b] / n[b] - conf[b] / n[b]);
  return total;
}

/** Multi-class Brier score of one answer. */
export function brierScore(question: Question, probabilities: Record<string, number>, label: string): number {
  return question.options.reduce((s, o) => s + ((probabilities[o.id] ?? 0) - (o.id === label ? 1 : 0)) ** 2, 0);
}

export function macroF1(pairs: { predicted: string; label: string }[]): number | null {
  if (!pairs.length) return null;
  const classes = new Set(pairs.flatMap(p => [p.predicted, p.label]));
  let sum = 0;
  for (const c of classes) {
    const tp = pairs.filter(p => p.predicted === c && p.label === c).length;
    const fp = pairs.filter(p => p.predicted === c && p.label !== c).length;
    const fn = pairs.filter(p => p.predicted !== c && p.label === c).length;
    sum += tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  }
  return sum / classes.size;
}

/** Replay a labelled set sequentially; writes no shadow records. ponytail: sequential and no retries, add concurrency when sets grow past a few thousand rows. */
export async function evaluate(question: Question, rows: EvalRow[], provider: ProviderConfig, options: Pick<DecideOptions, "key"> & { limit?: number; minMargin?: number } = {}): Promise<EvalReport> {
  // Validate everything before the first provider call, with the CLI's rules.
  question = parseQuestion(question);
  const ids = new Set(question.options.map(o => o.id));
  if (!Array.isArray(rows)) throw new UsageError("eval: rows must be an array");
  rows = rows.map((r, i) => parseRow(r, ids, `rows[${i}]`));
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new UsageError("eval: limit must be a positive integer");
  const minMargin = parseMinMargin(options.minMargin);
  provider = checkProvider(provider);
  const unknownOpts = Object.keys(options).filter(k => !["key", "limit", "minMargin"].includes(k));
  if (unknownOpts.length) throw new UsageError(`eval options: ${unknownFields(unknownOpts, ["key", "limit", "minMargin"])}`);
  if (options.key !== undefined && typeof options.key !== "function") throw new UsageError("eval options.key: give a function or leave it out");
  const used = options.limit === undefined ? rows : rows.slice(0, options.limit);
  const abstained: Record<string, number> = {};
  const latencies: number[] = [], pairs: { predicted: string; label: string }[] = [], calibration: { confidence: number; correct: boolean }[] = [];
  let skipped = 0, brierSum = 0, model = provider.model;
  for (const row of used) {
    if (row.pii && !provider.onPrem) { skipped++; continue; }
    const d = await decide({ question, state: row.state, minMargin }, provider, { shadowDir: null, ...(options.key ? { key: options.key } : {}) });
    model = d.decider.model;
    if (d.reason !== "state_too_long" && d.reason !== "off_prem") latencies.push(d.decider.latencyMs);
    if (d.abstain) abstained[d.reason] = (abstained[d.reason] ?? 0) + 1;
    else pairs.push({ predicted: d.choice!, label: row.label });
    if (Object.keys(d.probabilities).length) {
      // Same tie rule as the decision itself (question order), whatever the key order of the object.
      const top = topTwo(question, d.probabilities).choice;
      calibration.push({ confidence: d.probabilities[top] ?? 0, correct: top === row.label });
      brierSum += brierScore(question, d.probabilities, row.label);
    }
  }
  const evaluated = used.length - skipped;
  latencies.sort((a, b) => a - b);
  return {
    questionId: question.questionId, provider: provider.name, model,
    n: used.length, skipped, answered: pairs.length, abstained,
    accuracy: pairs.length ? pairs.filter(p => p.predicted === p.label).length / pairs.length : null,
    coverage: evaluated ? pairs.length / evaluated : null,
    macroF1: macroF1(pairs),
    ece: ece(calibration),
    brier: calibration.length ? brierSum / calibration.length : null,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}
