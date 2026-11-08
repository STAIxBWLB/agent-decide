import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { OPTION_ID, OUTCOME_WORDS, UsageError, type Decision, type Question } from "./contract.ts";
import { appendLine, readTextBounded } from "./io.ts";

/** Content-free decision log: ids, counts and closed words only. Never state, instructions or option descriptions. */
export interface DecisionRecord {
  v: 1; kind: "decision"; id: string; at: string; questionId: string; optionCount: number; options: string[];
  choice: string | null; margin: number; abstain: boolean; reason: string;
  provider: string; model: string; latencyMs: number; labelMass?: number; calibratedAt?: string; stateSha256: string;
}
export interface OutcomeRecord { v: 1; kind: "outcome"; id: string; at: string; label: string }
/** Content-free route record: policy, pick, rules and numbers; hashes of the turn id and evidence, never their text. */
export interface RouteRecord {
  v: 1; kind: "route"; id: string; at: string; policyId: string; turnIdSha256?: string; alias: string | null; effort: string | null;
  reason: string; rules: string[]; fallbackApplied: boolean; pinned: boolean; margin: number; contextTokens: number; pii: boolean;
  provider?: string; model?: string; latencyMs?: number; evidenceSha256: string;
}
/** What happened to a routed turn. */
export const ROUTE_OUTCOME_WORDS = ["completed", "failed", "retried", "unknown"] as const;
type ShadowRecord = DecisionRecord | OutcomeRecord | RouteRecord;

const FILE_BYTES = 256 * 1024 * 1024;
const ID = /^[0-9a-f]{32}$/;

export function shadowDir(home: string): string { return join(home, "shadow"); }

async function append(dir: string, at: Date, row: object) {
  await appendLine(join(dir, `${at.toISOString().slice(0, 7)}.jsonl`), JSON.stringify(row));
}

export async function appendDecision(dir: string, question: Question, decision: Decision, stateSha256: string, at = new Date()) {
  const row: DecisionRecord = {
    v: 1, kind: "decision", id: decision.id, at: at.toISOString(), questionId: decision.questionId, optionCount: question.options.length, options: question.options.map(o => o.id),
    choice: decision.choice, margin: decision.margin, abstain: decision.abstain, reason: decision.reason,
    provider: decision.decider.provider, model: decision.decider.model, latencyMs: decision.decider.latencyMs,
    ...(decision.labelMass === undefined ? {} : { labelMass: decision.labelMass }),
    ...(decision.calibration ? { calibratedAt: decision.calibration.fittedAt } : {}), stateSha256,
  };
  await append(dir, at, row);
}

export async function appendRoute(dir: string, row: RouteRecord) { await append(dir, new Date(row.at), row); }

export async function readRecords(dir: string): Promise<ShadowRecord[]> {
  let files: string[];
  try { files = (await readdir(dir)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); }
  catch (e) {
    // Only "no log yet" is an empty history; anything else must not look like "no records".
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new UsageError(`shadow log: cannot read ${dir} (${(e as NodeJS.ErrnoException).code ?? "error"}); check that it is a directory you can read, or set ADEC_HOME`);
  }
  const rows: ShadowRecord[] = [];
  for (const f of files) {
    const text = await readTextBounded(join(dir, f), FILE_BYTES, "shadow log");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.v === 1 && (row.kind === "decision" || row.kind === "outcome" || row.kind === "route")) rows.push(row);
      } catch { /* a torn last line from a crash is skipped, not fatal */ }
    }
  }
  return rows;
}

/**
 * Record the outcome a consumer observed: for a decision, one of its option ids or accepted|rejected|unknown;
 * for a route, completed|failed|retried|unknown.
 */
export async function labelOutcome(dir: string, id: string, label: string, at = new Date()): Promise<OutcomeRecord> {
  if (typeof dir !== "string" || !dir) throw new UsageError("shadow label: give the shadow directory");
  if (typeof id !== "string" || !ID.test(id)) throw new UsageError("shadow label: give the 32-hex id printed by adec ask or adec route");
  if (typeof label !== "string") throw new UsageError("shadow label: give the label as a string");
  const record = (await readRecords(dir)).find((r): r is DecisionRecord | RouteRecord => (r.kind === "decision" || r.kind === "route") && r.id === id);
  if (!record) throw new UsageError(`shadow label: no decision or route ${id} in the shadow log; check ADEC_HOME`);
  const allowed: readonly string[] = record.kind === "route" ? ROUTE_OUTCOME_WORDS : [...record.options, ...OUTCOME_WORDS];
  if (!OPTION_ID.test(label) || !allowed.includes(label)) throw new UsageError(`shadow label: use one of ${allowed.join(", ")}`);
  const row: OutcomeRecord = { v: 1, kind: "outcome", id, at: at.toISOString(), label };
  await append(dir, at, row);
  return row;
}

export interface QuestionReport { questionId: string; decisions: number; abstained: Record<string, number>; labelled: number; agreed: number; agreement: number | null }

/** Per-question counts; the latest outcome for a decision wins; agreement counts labelled decisions with a choice. */
function checkDir(dir: unknown, what: string): void {
  if (typeof dir !== "string" || !dir) throw new UsageError(`${what}: give the shadow directory (shadowDir of ADEC_HOME)`);
}

export async function shadowReport(dir: string): Promise<QuestionReport[]> {
  checkDir(dir, "shadowReport");
  const rows = await readRecords(dir);
  const outcomes = new Map<string, string>();
  for (const r of rows) if (r.kind === "outcome") outcomes.set(r.id, r.label);
  const by = new Map<string, QuestionReport & { compared: number }>();
  for (const r of rows) {
    if (r.kind !== "decision") continue;
    const q = by.get(r.questionId) ?? { questionId: r.questionId, decisions: 0, abstained: {}, labelled: 0, agreed: 0, agreement: null, compared: 0 };
    q.decisions++;
    if (r.abstain) q.abstained[r.reason] = (q.abstained[r.reason] ?? 0) + 1;
    const label = outcomes.get(r.id);
    if (label !== undefined) {
      q.labelled++;
      if (r.choice !== null && r.options.includes(label)) { q.compared++; if (label === r.choice) q.agreed++; }
    }
    by.set(r.questionId, q);
  }
  return [...by.values()].sort((a, b) => a.questionId.localeCompare(b.questionId))
    .map(({ compared, ...q }) => ({ ...q, agreement: compared ? q.agreed / compared : null }));
}

export interface PolicyReport {
  policyId: string; routes: number; byReason: Record<string, number>; fallbackApplied: number; pinned: number;
  labelled: number; outcomes: Record<string, number>;
}

/** Per-policy route counts; the latest outcome for a route wins. */
export async function routeReport(dir: string): Promise<PolicyReport[]> {
  checkDir(dir, "routeReport");
  const rows = await readRecords(dir);
  const outcomes = new Map<string, string>();
  for (const r of rows) if (r.kind === "outcome") outcomes.set(r.id, r.label);
  const by = new Map<string, PolicyReport>();
  for (const r of rows) {
    if (r.kind !== "route") continue;
    const p = by.get(r.policyId) ?? { policyId: r.policyId, routes: 0, byReason: {}, fallbackApplied: 0, pinned: 0, labelled: 0, outcomes: {} };
    p.routes++;
    p.byReason[r.reason] = (p.byReason[r.reason] ?? 0) + 1;
    if (r.fallbackApplied) p.fallbackApplied++;
    if (r.pinned) p.pinned++;
    const label = outcomes.get(r.id);
    if (label !== undefined) { p.labelled++; p.outcomes[label] = (p.outcomes[label] ?? 0) + 1; }
    by.set(r.policyId, p);
  }
  return [...by.values()].sort((a, b) => a.policyId.localeCompare(b.policyId));
}
