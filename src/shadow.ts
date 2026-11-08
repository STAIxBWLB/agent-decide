import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OPTION_ID, OUTCOME_WORDS, UsageError, type Decision, type Question } from "./contract.ts";
import { readTextBounded } from "./io.ts";

/** Content-free decision log: ids, counts and closed words only. Never state, instructions or option descriptions. */
export interface DecisionRecord {
  v: 1; kind: "decision"; id: string; at: string; questionId: string; options: string[];
  choice: string | null; margin: number; abstain: boolean; reason: string;
  provider: string; model: string; latencyMs: number; labelMass?: number; stateSha256: string;
}
export interface OutcomeRecord { v: 1; kind: "outcome"; id: string; at: string; label: string }

const FILE_BYTES = 256 * 1024 * 1024;
const ID = /^[0-9a-f]{32}$/;

export function shadowDir(home: string): string { return join(home, "shadow"); }

async function append(dir: string, at: Date, row: object) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, `${at.toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export async function appendDecision(dir: string, question: Question, decision: Decision, stateSha256: string, at = new Date()) {
  const row: DecisionRecord = {
    v: 1, kind: "decision", id: decision.id, at: at.toISOString(), questionId: decision.questionId, options: question.options.map(o => o.id),
    choice: decision.choice, margin: decision.margin, abstain: decision.abstain, reason: decision.reason,
    provider: decision.decider.provider, model: decision.decider.model, latencyMs: decision.decider.latencyMs,
    ...(decision.labelMass === undefined ? {} : { labelMass: decision.labelMass }), stateSha256,
  };
  await append(dir, at, row);
}

export async function readRecords(dir: string): Promise<(DecisionRecord | OutcomeRecord)[]> {
  let files: string[];
  try { files = (await readdir(dir)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const rows: (DecisionRecord | OutcomeRecord)[] = [];
  for (const f of files) {
    const text = await readTextBounded(join(dir, f), FILE_BYTES, "shadow log");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.v === 1 && (row.kind === "decision" || row.kind === "outcome")) rows.push(row);
      } catch { /* a torn last line from a crash is skipped, not fatal */ }
    }
  }
  return rows;
}

/** Record the outcome a consumer observed for a decision: one of its option ids or accepted|rejected|unknown. */
export async function labelOutcome(dir: string, id: string, label: string, at = new Date()): Promise<OutcomeRecord> {
  if (!ID.test(id)) throw new UsageError("shadow label: give the 32-hex decision id printed by adec ask");
  const decision = (await readRecords(dir)).find((r): r is DecisionRecord => r.kind === "decision" && r.id === id);
  if (!decision) throw new UsageError(`shadow label: no decision ${id} in the shadow log; check ADEC_HOME`);
  const allowed = [...decision.options, ...OUTCOME_WORDS];
  if (!OPTION_ID.test(label) || !allowed.includes(label)) throw new UsageError(`shadow label: use one of ${allowed.join(", ")}`);
  const row: OutcomeRecord = { v: 1, kind: "outcome", id, at: at.toISOString(), label };
  await append(dir, at, row);
  return row;
}

export interface QuestionReport { questionId: string; decisions: number; abstained: Record<string, number>; labelled: number; agreed: number; agreement: number | null }

/** Per-question counts; the latest outcome for a decision wins; agreement counts labelled decisions with a choice. */
export async function shadowReport(dir: string): Promise<QuestionReport[]> {
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
