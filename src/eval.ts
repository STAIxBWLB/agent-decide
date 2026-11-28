import { createHash } from "node:crypto";
import { checkProvider, type ProviderConfig } from "./config.ts";
import { parseMinMargin, parseQuestion, fields, OPTION_ID, topTwo, UsageError, type Decision, type Question, type Reason } from "./contract.ts";
import { decide, type DecideOptions } from "./decide.ts";

export interface EvalRow { id?: string; state: string; label: string; pii?: boolean; tags?: string[] }
export interface SliceMetrics {
  n: number; answered: number; accuracy: number | null; coverage: number | null;
  macroF1: number | null; ece: number | null; brier: number | null;
}
interface RowIdentity { v: 1; n: number; id?: string; rowSha256: string; label: string; tags: string[] }
export type EvalRowResult = RowIdentity & ({ skipped: true } | {
  skipped: false; choice: string | null; abstain: boolean; reason: Reason; margin: number;
  top: string | null; probabilities: Record<string, number>; latencyMs: number; flipChoice?: string | null;
});
export interface EvalReport extends SliceMetrics {
  questionId: string; provider: string; model: string; version?: string;
  skipped: number; abstained: Record<string, number>;
  latencyMs: { p50: number | null; p95: number | null };
  slices: Record<string, SliceMetrics>;
  flip?: { n: number; bothAnswered: number; agreed: number; agreement: number | null };
  rows?: EvalRowResult[];
}

const ROW_ID = /^[A-Za-z0-9._:-]{1,128}$/;
function parseTags(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 8 || Array.from(raw).some(t => typeof t !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(t)) || new Set(raw).size !== raw.length)
    throw new UsageError(`${where}: tags must be at most 8 unique closed words (a-z, 0-9, '.', '_' or '-')`);
  return [...raw];
}
function checkRowId(id: unknown, where: string): void {
  if (id !== undefined && (typeof id !== "string" || !ROW_ID.test(id))) throw new UsageError(`${where}: id must be 1-128 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-'`);
}

/** One row check for the CLI file reader and the library entry point alike. */
export function parseRow(raw: unknown, ids: Set<string>, where: string): EvalRow {
  const r = fields(raw, ["id", "state", "label", "pii", "tags"], where);
  checkRowId(r.id, where);
  if (typeof r.state !== "string") throw new UsageError(`${where}: state must be a string`);
  if (typeof r.label !== "string" || !ids.has(r.label)) throw new UsageError(`${where}: label must be one of the question's option ids`);
  if (r.pii !== undefined && typeof r.pii !== "boolean") throw new UsageError(`${where}: pii must be true or false`);
  const tags = parseTags(r.tags, where);
  return { state: r.state, label: r.label, ...(r.id === undefined ? {} : { id: r.id as string }), ...(r.pii ? { pii: true } : {}), ...(r.tags === undefined ? {} : { tags }) };
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

interface Metrics {
  n: number; skipped: number; brierSum: number;
  pairs: { predicted: string; label: string }[];
  calibration: { confidence: number; correct: boolean }[];
}
const metrics = (): Metrics => ({ n: 0, skipped: 0, brierSum: 0, pairs: [], calibration: [] });
function addMetrics(m: Metrics, row: EvalRowResult, question: Question): void {
  m.n++;
  if (row.skipped) { m.skipped++; return; }
  if (!row.abstain) m.pairs.push({ predicted: row.choice!, label: row.label });
  if (row.top !== null) {
    m.calibration.push({ confidence: row.probabilities[row.top]!, correct: row.top === row.label });
    m.brierSum += brierScore(question, row.probabilities, row.label);
  }
}
function metricReport(m: Metrics): SliceMetrics {
  return {
    n: m.n, answered: m.pairs.length,
    accuracy: m.pairs.length ? m.pairs.filter(p => p.predicted === p.label).length / m.pairs.length : null,
    coverage: m.n - m.skipped ? m.pairs.length / (m.n - m.skipped) : null,
    macroF1: macroF1(m.pairs), ece: ece(m.calibration),
    brier: m.calibration.length ? m.brierSum / m.calibration.length : null,
  };
}

export interface EvalOptions extends Pick<DecideOptions, "key"> {
  limit?: number; minMargin?: number; perRow?: boolean; flipQuestion?: Question;
}
export function parseEvalOptions(raw: EvalOptions, question: Question): EvalOptions {
  const o = fields(raw, ["key", "limit", "minMargin", "perRow", "flipQuestion"], "eval options");
  if (o.limit !== undefined && (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 1)) throw new UsageError("eval: limit must be a positive integer");
  if (o.perRow !== undefined && typeof o.perRow !== "boolean") throw new UsageError("eval: perRow must be true or false");
  if (o.key !== undefined && typeof o.key !== "function") throw new UsageError("eval options.key: give a function or leave it out");
  const flipQuestion = o.flipQuestion === undefined ? undefined : parseQuestion(o.flipQuestion);
  if (flipQuestion && (flipQuestion.questionId === question.questionId || flipQuestion.options.length !== question.options.length || flipQuestion.options.some(f => !question.options.some(q => q.id === f.id))))
    throw new UsageError("eval: flip question needs a different questionId and exactly the same option id set");
  return { ...raw, minMargin: parseMinMargin(o.minMargin), ...(flipQuestion ? { flipQuestion } : {}) };
}

interface RunInfo { questionId: string; provider: string; model: string; version?: string; flip: boolean }
type Decided = Exclude<EvalRowResult, { skipped: true }>;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One provider pass over a row: the shared core of eval and predict. Returns null for a PII row on an off-prem provider (no request is built). */
async function decideRow(question: Question, state: string, pii: boolean | undefined, provider: ProviderConfig, options: EvalOptions): Promise<Omit<Decided, keyof RowIdentity> | null> {
  if (pii && !provider.onPrem) return null;
  const callOptions = { shadowDir: null, ...(options.key ? { key: options.key } : {}) };
  const d: Decision = await decide({ question, state, minMargin: options.minMargin }, provider, callOptions);
  const top = Object.keys(d.probabilities).length ? topTwo(question, d.probabilities).choice : null;
  const result: Omit<Decided, keyof RowIdentity> = { skipped: false, choice: d.choice, abstain: d.abstain, reason: d.reason,
    margin: d.margin, top, probabilities: d.probabilities, latencyMs: d.decider.latencyMs };
  if (options.flipQuestion) result.flipChoice = (await decide({ question: options.flipQuestion, state, minMargin: options.minMargin }, provider, callOptions)).choice;
  return result;
}

/**
 * Option order for the report: JavaScript property order of the option ids, which is what a prediction record's
 * rowSha256ByOption keeps after JSON (digit-only ids such as "1" come first, ascending). Equal to question order
 * whenever no id is digit-only, so eval and score sum Brier terms in the same order and report byte-identical metrics.
 */
const recordOrder = (question: Question): string[] => Object.keys(Object.fromEntries(question.options.map(o => [o.id, 0])));

/** The eval report, computed from per-row results alone, so eval and score share it. */
function report(optionIds: string[], run: RunInfo, results: EvalRowResult[], perRow: boolean): EvalReport {
  const question = { options: optionIds.map(id => ({ id })) } as Question;
  const all = metrics(), slices = new Map<string, Metrics>();
  const abstained: Record<string, number> = {}, latencies: number[] = [];
  const flip = { n: 0, bothAnswered: 0, agreed: 0, agreement: null as number | null };
  for (const result of results) {
    if (!result.skipped) {
      if (result.reason !== "state_too_long" && result.reason !== "off_prem") latencies.push(result.latencyMs);
      if (result.abstain) abstained[result.reason] = (abstained[result.reason] ?? 0) + 1;
      if (run.flip) {
        flip.n++;
        const f = result.flipChoice ?? null;
        if (!result.abstain && f !== null) { flip.bothAnswered++; if (result.choice === f) flip.agreed++; }
      }
    }
    addMetrics(all, result, question);
    for (const tag of result.tags) {
      if (!slices.has(tag)) slices.set(tag, metrics());
      addMetrics(slices.get(tag)!, result, question);
    }
  }
  latencies.sort((a, b) => a - b);
  flip.agreement = flip.n ? flip.agreed / flip.n : null;
  return {
    questionId: run.questionId, provider: run.provider, model: run.model,
    ...(run.version === undefined ? {} : { version: run.version }),
    ...metricReport(all), skipped: all.skipped, abstained,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    slices: Object.fromEntries([...slices].map(([tag, m]) => [tag, metricReport(m)])),
    ...(run.flip ? { flip } : {}), ...(perRow ? { rows: results } : {}),
  };
}
const runInfo = (question: Question, provider: ProviderConfig, flip: boolean): RunInfo => ({ questionId: question.questionId, provider: provider.name, model: provider.model,
  ...(provider.version === undefined ? {} : { version: provider.version }), flip });

/** Replay sequentially without shadow records; optional returned rows contain no request content. */
export async function evaluate(question: Question, rows: EvalRow[], provider: ProviderConfig, options: EvalOptions = {}): Promise<EvalReport> {
  question = parseQuestion(question);
  const ids = new Set(question.options.map(o => o.id));
  if (!Array.isArray(rows)) throw new UsageError("eval: rows must be an array");
  rows = Array.from(rows, (r, i) => parseRow(r, ids, `rows[${i}]`));
  options = parseEvalOptions(options, question);
  provider = checkProvider(provider);
  const used = options.limit === undefined ? rows : rows.slice(0, options.limit);
  const results: EvalRowResult[] = [];
  for (const [n, row] of used.entries()) {
    const identity: RowIdentity = { v: 1, n, ...(row.id === undefined ? {} : { id: row.id }),
      rowSha256: sha256([row.state, row.label]), label: row.label, tags: row.tags ?? [] };
    const decided = await decideRow(question, row.state, row.pii, provider, options);
    results.push(decided ? { ...identity, ...decided } : { ...identity, skipped: true });
  }
  return report(recordOrder(question), runInfo(question, provider, !!options.flipQuestion), results, !!options.perRow);
}

/** An unlabelled set row for predict: every row needs an id, since score joins on it. */
export interface PredictRow { id: string; state: string; pii?: boolean; tags?: string[] }
export function parsePredictRow(raw: unknown, where: string): PredictRow {
  const r = fields(raw, ["id", "state", "pii", "tags"], where);
  if (r.id === undefined) throw new UsageError(`${where}: id is required (score joins predictions to labels by id)`);
  checkRowId(r.id, where);
  if (typeof r.state !== "string") throw new UsageError(`${where}: state must be a string`);
  if (r.pii !== undefined && typeof r.pii !== "boolean") throw new UsageError(`${where}: pii must be true or false`);
  const tags = parseTags(r.tags, where);
  return { id: r.id as string, state: r.state, ...(r.pii ? { pii: true } : {}), ...(r.tags === undefined ? {} : { tags }) };
}
export const parsePredictRows = (text: string): PredictRow[] => jsonl(text, "set", parsePredictRow);

/** A label-free prediction record: the eval row format without label and rowSha256, plus stateSha256, rowSha256ByOption and run. */
export type PredictionRecord = Omit<RowIdentity, "label" | "rowSha256" | "id"> & { id: string; stateSha256: string; rowSha256ByOption: Record<string, string>; run: RunInfo }
  & ({ skipped: true } | Omit<Decided, keyof RowIdentity>);
export interface PredictOptions extends Pick<DecideOptions, "key"> { flipQuestion?: Question }

/** Label-free replay: no label is read or written, no shadow record, no metric. */
export async function predict(question: Question, rows: PredictRow[], provider: ProviderConfig, options: PredictOptions = {}): Promise<PredictionRecord[]> {
  question = parseQuestion(question);
  if (!Array.isArray(rows)) throw new UsageError("predict: rows must be an array");
  rows = Array.from(rows, (r, i) => parsePredictRow(r, `rows[${i}]`));
  const seen = new Set<string>();
  rows.forEach((r, i) => { if (seen.has(r.id)) throw new UsageError(`rows[${i}]: duplicate id`); seen.add(r.id); });
  const o = fields(options, ["key", "flipQuestion"], "predict options");
  const parsed = parseEvalOptions({ ...(o.key === undefined ? {} : { key: o.key as EvalOptions["key"] }), ...(o.flipQuestion === undefined ? {} : { flipQuestion: o.flipQuestion as Question }) }, question);
  provider = checkProvider(provider);
  const run = runInfo(question, provider, !!parsed.flipQuestion), records: PredictionRecord[] = [];
  for (const [n, row] of rows.entries()) {
    const identity = { v: 1 as const, n, id: row.id, stateSha256: sha256(row.state),
      rowSha256ByOption: Object.fromEntries(question.options.map(opt => [opt.id, sha256([row.state, opt.id])])), tags: row.tags ?? [], run };
    const decided = await decideRow(question, row.state, row.pii, provider, parsed);
    records.push(decided ? { ...identity, ...decided } : { ...identity, skipped: true });
  }
  return records;
}

export interface LabelRow { id: string; label: string }
export function parseLabelRow(raw: unknown, where: string): LabelRow {
  const r = fields(raw, ["id", "label"], where);
  if (r.id === undefined) throw new UsageError(`${where}: id is required`);
  checkRowId(r.id, where);
  if (!optionId(r.label)) throw new UsageError(`${where}: label must be an option id`);
  return { id: r.id as string, label: r.label };
}
function jsonl<T>(text: string, what: string, parse: (raw: unknown, where: string) => T): T[] {
  const out: T[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new UsageError(`${what} line ${i + 1}: not valid JSON`); }
    out.push(parse(raw, `${what} line ${i + 1}`));
  });
  return out;
}
export const parseLabelRows = (text: string): LabelRow[] => jsonl(text, "labels", parseLabelRow);
export const parsePredictionRecords = (text: string): unknown[] => jsonl(text, "predictions", raw => raw);

const SHA = /^[a-f0-9]{64}$/;
function parseRun(raw: unknown, where: string): RunInfo {
  const r = fields(raw, ["questionId", "provider", "model", "version", "flip"], `${where} run`);
  if (typeof r.questionId !== "string" || typeof r.provider !== "string" || typeof r.model !== "string" || (r.version !== undefined && typeof r.version !== "string") || typeof r.flip !== "boolean")
    throw new UsageError(`${where}: run needs questionId, provider, model, optional version and flip`);
  return { questionId: r.questionId, provider: r.provider, model: r.model, ...(r.version === undefined ? {} : { version: r.version as string }), flip: r.flip };
}

/** Join prediction records to labels by id and report exactly as eval does; rows are in the eval row format. */
export async function score(predictions: PredictionRecord[], labels: LabelRow[]): Promise<EvalReport> {
  if (!Array.isArray(predictions) || !Array.isArray(labels)) throw new UsageError("score: give arrays of prediction records and labels");
  if (!predictions.length) throw new UsageError("score: no prediction records");
  const byId = new Map<string, string>();
  labels.forEach((raw, i) => {
    const l = parseLabelRow(raw, `labels[${i}]`);
    if (byId.has(l.id)) throw new UsageError(`score: labels[${i}]: duplicate id`);
    byId.set(l.id, l.label);
  });
  let run: RunInfo | undefined, optionIds: string[] | undefined;
  const used = new Set<string>(), results: EvalRowResult[] = [];
  predictions.forEach((raw, n) => {
    const where = `prediction record ${n}`;
    const { stateSha256, rowSha256ByOption, run: rawRun, ...rest } = fields(raw, [...RESULT_FIELDS.filter(k => k !== "label" && k !== "rowSha256"), "stateSha256", "rowSha256ByOption", "run"], where);
    if (rest.id === undefined) throw new UsageError(`${where}: id is required`);
    checkRowId(rest.id, where);
    if (typeof stateSha256 !== "string" || !SHA.test(stateSha256)) throw new UsageError(`${where}: stateSha256 must be a sha256; re-run adec predict, the records were edited or truncated`);
    const hashes = fields(rowSha256ByOption, Object.keys(rowSha256ByOption && typeof rowSha256ByOption === "object" ? rowSha256ByOption : {}), `${where} rowSha256ByOption`);
    const ids = Object.keys(hashes);
    if (ids.length < 2 || ids.length > 26 || ids.some(k => !optionId(k) || typeof hashes[k] !== "string" || !SHA.test(hashes[k] as string))) throw new UsageError(`${where}: rowSha256ByOption needs a sha256 per option id; re-run adec predict, the records were edited or truncated`);
    const thisRun = parseRun(rawRun, where);
    if (run === undefined) { run = thisRun; optionIds = ids; }
    else if (JSON.stringify(run) !== JSON.stringify(thisRun) || JSON.stringify(optionIds) !== JSON.stringify(ids)) throw new UsageError(`${where}: run or option set differs from record 0; score one adec predict output at a time`);
    const id = rest.id as string, label = byId.get(id);
    if (label === undefined) throw new UsageError(`score: ${where}: no label for this id; add it to the labels file`);
    if (used.has(id)) throw new UsageError(`score: ${where}: duplicate id`);
    used.add(id);
    if (!ids.includes(label)) throw new UsageError(`score: label for ${where} is not one of its option ids`);
    const { v, n: rn, id: _id, tags, ...decision } = rest;
    const row = parseRowResult({ v, n: rn, id, rowSha256: hashes[label], label, tags, ...decision }, n, where);
    if (!row.skipped && Object.keys(row.probabilities).length && JSON.stringify(Object.keys(row.probabilities)) !== JSON.stringify(ids)) throw new UsageError(`${where}: probabilities must cover exactly the option ids`);
    if (thisRun.flip !== (!row.skipped && row.flipChoice !== undefined) && !row.skipped) throw new UsageError(`${where}: flipChoice must be present exactly when run.flip is true`);
    results.push(row);
  });
  if (used.size !== byId.size) throw new UsageError(`score: ${byId.size - used.size} label id(s) have no prediction record; re-run adec predict on the full set or drop those labels`);
  return report(optionIds!, run!, results, true);
}

const RESULT_FIELDS = ["v", "n", "id", "rowSha256", "label", "tags", "skipped", "choice", "abstain", "reason", "margin", "top", "probabilities", "latencyMs", "flipChoice"];
const REASONS: readonly string[] = ["ok", "low_margin", "off_prem", "timeout", "http", "malformed", "outside_options", "state_too_long"];
const optionId = (value: unknown): value is string => typeof value === "string" && OPTION_ID.test(value);
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Closed, content-free result schema, used for both file and library inputs. */
function parseRowResult(raw: unknown, n: number, where = `eval result row ${n}`): EvalRowResult {
  const r = fields(raw, RESULT_FIELDS, where);
  checkRowId(r.id, where);
  if (r.v !== 1 || r.n !== n || typeof r.rowSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.rowSha256) || !optionId(r.label) || !Array.isArray(r.tags) || typeof r.skipped !== "boolean")
    throw new UsageError(`${where}: expected v 1, consecutive zero-based n, sha256, option label, tags and skipped`);
  const identity: RowIdentity = { v: 1, n, ...(r.id === undefined ? {} : { id: r.id as string }), rowSha256: r.rowSha256, label: r.label, tags: parseTags(r.tags, where) };
  if (r.skipped) {
    if (Object.keys(r).some(k => !["v", "n", "id", "rowSha256", "label", "tags", "skipped"].includes(k))) throw new UsageError(`${where}: skipped rows must have no decision fields`);
    return { ...identity, skipped: true };
  }
  if ((r.choice !== null && !optionId(r.choice)) || typeof r.abstain !== "boolean" || r.abstain !== (r.choice === null) || !REASONS.includes(r.reason as string) || (r.reason === "ok") !== !r.abstain || !unit(r.margin) || typeof r.latencyMs !== "number" || !Number.isFinite(r.latencyMs) || r.latencyMs < 0 || (r.top !== null && !optionId(r.top)) || (r.flipChoice !== undefined && r.flipChoice !== null && !optionId(r.flipChoice)))
    throw new UsageError(`${where}: invalid decision fields`);
  const probs = fields(r.probabilities, Object.keys(r.probabilities && typeof r.probabilities === "object" ? r.probabilities : {}), `${where} probabilities`);
  const keys = Object.keys(probs), probabilities: Record<string, number> = {};
  if (keys.length) {
    if (keys.length < 2 || keys.length > 26 || keys.some(k => !optionId(k) || !unit(probs[k])) || !Object.hasOwn(probs, r.label) || typeof r.top !== "string" || !Object.hasOwn(probs, r.top) || (r.choice !== null && r.choice !== r.top) || (r.flipChoice !== undefined && r.flipChoice !== null && !Object.hasOwn(probs, r.flipChoice)) || !["ok", "low_margin"].includes(r.reason as string)) throw new UsageError(`${where}: invalid probability distribution`);
    for (const k of keys) probabilities[k] = probs[k] as number;
    const sorted = Object.values(probabilities).sort((a, b) => b - a);
    if (Math.abs(sorted.reduce((s, p) => s + p, 0) - 1) > 0.001 || probabilities[r.top] !== sorted[0] || Math.abs(r.margin - (sorted[0]! - sorted[1]!)) > 0.001) throw new UsageError(`${where}: inconsistent top or margin`);
  } else if (r.top !== null || r.choice !== null || r.margin !== 0 || ["ok", "low_margin"].includes(r.reason as string)) throw new UsageError(`${where}: missing probability distribution`);
  return { ...identity, skipped: false, choice: r.choice as string | null, abstain: r.abstain, reason: r.reason as Reason,
    margin: r.margin, top: r.top as string | null, probabilities, latencyMs: r.latencyMs,
    ...(r.flipChoice === undefined ? {} : { flipChoice: r.flipChoice as string | null }) };
}

/** Internal CLI reader; compareRows runs the same schema again at its public boundary. */
export function parseResultRows(text: string): EvalRowResult[] {
  const rows: EvalRowResult[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new UsageError("eval results: not valid JSONL"); }
    rows.push(parseRowResult(raw, rows.length));
  }
  return rows;
}

export interface CompareOptions { seed: number; resamples?: number }
export function parseCompareOptions(raw: unknown): Required<CompareOptions> {
  const o = fields(raw, ["seed", "resamples"], "eval compare options");
  if (typeof o.seed !== "number" || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 4294967295) throw new UsageError("eval compare: seed is required, give an integer from 0 to 4294967295");
  const resamples = o.resamples === undefined ? 2000 : o.resamples;
  if (typeof resamples !== "number" || !Number.isSafeInteger(resamples) || resamples < 1) throw new UsageError("eval compare: resamples must be a positive safe integer");
  return { seed: o.seed, resamples };
}
export interface CompareSlice { n: number; accuracyA: number | null; accuracyB: number | null; diff: number | null }
export interface CompareReport extends CompareSlice {
  bothCorrect: number; aOnly: number; bOnly: number; bothWrong: number; mcnemarP: number;
  bootstrap: { seed: number; resamples: number; lo: number | null; hi: number | null };
  agreement: number | null; slices: Record<string, CompareSlice>;
}

/** Exact two-sided binomial test on discordant pairs, evaluated from the smaller tail. */
function mcnemar(aOnly: number, bOnly: number): number {
  const n = aOnly + bOnly, k = Math.min(aOnly, bOnly);
  if (!n || 2 * k >= n - 1) return 1;
  let logMass = -n * Math.LN2;
  for (let i = 1; i <= k; i++) logMass += Math.log(n - i + 1) - Math.log(i);
  let relative = 1, tail = 1;
  for (let i = k; i > 0; i--) { relative *= i / (n - i + 1); tail += relative; }
  return Math.min(1, 2 * Math.exp(logMass) * tail);
}

/** Mulberry32: 32-bit integer arithmetic and Math.imul make the sequence platform-independent. */
function random32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function compareMetrics(deltas: { a: number; b: number }[]): CompareSlice {
  const n = deltas.length;
  return { n, accuracyA: n ? deltas.reduce((s, d) => s + d.a, 0) / n : null,
    accuracyB: n ? deltas.reduce((s, d) => s + d.b, 0) / n : null,
    diff: n ? deltas.reduce((s, d) => s + d.b - d.a, 0) / n : null };
}

/** Pair full input sequences by index and hash, excluding a pair if either side was skipped. No winner verdict. */
export async function compareRows(a: EvalRowResult[], b: EvalRowResult[], options: CompareOptions): Promise<CompareReport> {
  const { seed, resamples } = parseCompareOptions(options);
  if (!Array.isArray(a) || !Array.isArray(b)) throw new UsageError("eval compare: give two arrays of per-row results");
  a = Array.from(a, (r, i) => parseRowResult(r, i)); b = Array.from(b, (r, i) => parseRowResult(r, i));
  if (a.length !== b.length) throw new UsageError("eval compare: row count mismatch");
  const deltas: { a: number; b: number }[] = [], slices = new Map<string, { a: number; b: number }[]>();
  let bothCorrect = 0, aOnly = 0, bOnly = 0, bothWrong = 0, agreed = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.n !== y.n || x.rowSha256 !== y.rowSha256 || x.id !== y.id || x.label !== y.label || JSON.stringify([...x.tags].sort()) !== JSON.stringify([...y.tags].sort())) throw new UsageError(`eval compare: row ${i} identity mismatch`);
    if (x.skipped || y.skipped) continue;
    const ac = !x.abstain && x.choice === x.label, bc = !y.abstain && y.choice === y.label;
    if (ac && bc) bothCorrect++; else if (ac) aOnly++; else if (bc) bOnly++; else bothWrong++;
    if (!x.abstain && !y.abstain && x.choice === y.choice) agreed++;
    const delta = { a: Number(ac), b: Number(bc) };
    deltas.push(delta);
    for (const tag of x.tags) { if (!slices.has(tag)) slices.set(tag, []); slices.get(tag)!.push(delta); }
  }
  const random = random32(seed), boot: number[] = [], n = deltas.length;
  if (n) for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) { const d = deltas[Math.floor(random() * n)]!; sum += d.b - d.a; }
    boot.push(sum / n);
  }
  boot.sort((a, b) => a - b);
  return { ...compareMetrics(deltas), bothCorrect, aOnly, bOnly, bothWrong, mcnemarP: mcnemar(aOnly, bOnly),
    bootstrap: { seed, resamples, lo: percentile(boot, 0.025), hi: percentile(boot, 0.975) },
    agreement: n ? agreed / n : null, slices: Object.fromEntries([...slices].map(([tag, ds]) => [tag, compareMetrics(ds)])) };
}
