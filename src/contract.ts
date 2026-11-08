/** The decision contract (issue #2): typed choice questions, requests and decisions. */

export const MIN_OPTIONS = 2;
/** The smallest cap among target servers: single-token labels A..Z (logits adapter, vLLM). */
export const MAX_OPTIONS = 26;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_DESCRIPTION = 500;

export type Reason = "ok" | "low_margin" | "off_prem" | "timeout" | "http" | "malformed" | "outside_options" | "state_too_long";
export const OUTCOME_WORDS = ["accepted", "rejected", "unknown"] as const;

export interface Option { id: string; description?: string }
export interface Question { questionId: string; instructions: string; options: Option[] }
export interface AskRequest { question: Question; state: string; pii?: boolean; minMargin?: number }

/** What a provider adapter returns: probabilities over exactly the option ids. */
/** The configured model name is reported, never a server-supplied string (it could reflect the key or the state). */
export interface ProviderAnswer { probabilities: Record<string, number>; labelMass?: number }

export interface Decider { provider: string; kind: string; model: string; version?: string; latencyMs: number }
export interface Decision {
  id: string;
  questionId: string;
  choice: string | null;
  probabilities: Record<string, number>;
  margin: number;
  abstain: boolean;
  reason: Reason;
  labelMass?: number;
  /** Present when a calibration fit applied (probabilities and margin are tempered). */
  calibration?: { questionId: string; method: "temperature"; fittedAt: string };
  decider: Decider;
}

/** A caller mistake (bad file, option or configuration): exit code 2. The message names the field and the fix. */
export class UsageError extends Error {}

const QUESTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** "unknown field(s)" without echoing the names: a caller-sent key is unvalidated text and may be content. */
export function unknownFields(unknown: readonly string[], allowed: readonly string[], noun = "field"): string {
  return `${unknown.length} unknown ${noun}${unknown.length > 1 ? "s" : ""}; allowed ${noun}s are ${allowed.join(", ") || "none"}`;
}

/** A JSON object with only the allowed keys. */
export function fields(raw: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${where}: expected a JSON object`);
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) throw new UsageError(`${where}: ${unknownFields(unknown, allowed)}`);
  return raw as Record<string, unknown>;
}

export function parseQuestion(raw: unknown): Question {
  const q = fields(raw, ["questionId", "instructions", "options"], "question");
  if (typeof q.questionId !== "string" || !QUESTION_ID.test(q.questionId))
    throw new UsageError("question.questionId: use 1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit (for example \"ahub.triage.v1\")");
  if (typeof q.instructions !== "string" || !q.instructions.trim() || q.instructions.length > MAX_INSTRUCTIONS)
    throw new UsageError(`question.instructions: give a non-empty string of at most ${MAX_INSTRUCTIONS} characters`);
  if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS)
    throw new UsageError(`question.options: give ${MIN_OPTIONS} to ${MAX_OPTIONS} options; split a larger set into two questions`);
  const seen = new Set<string>();
  const options = q.options.map((rawOption, i) => {
    const o = fields(rawOption, ["id", "description"], `question.options[${i}]`);
    if (typeof o.id !== "string" || !OPTION_ID.test(o.id))
      throw new UsageError(`question.options[${i}].id: use 1-32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit`);
    if (seen.has(o.id)) throw new UsageError(`question.options[${i}].id: duplicate id ${JSON.stringify(o.id)}; option ids must be unique`);
    seen.add(o.id);
    if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > MAX_DESCRIPTION || /[\r\n]/.test(o.description)))
      throw new UsageError(`question.options[${i}].description: give a single-line string of at most ${MAX_DESCRIPTION} characters`);
    return o.description === undefined ? { id: o.id } : { id: o.id, description: o.description };
  });
  return { questionId: q.questionId, instructions: q.instructions, options };
}

export function parseMinMargin(raw: unknown): number {
  if (raw === undefined) return 0;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw new UsageError("min margin: give a number from 0 to 1 (the gap between the top two probabilities)");
  return n;
}

/** Margin = top-1 minus top-2 probability; the choice is the first option (in question order) with the top probability. */
export function topTwo(question: Question, probabilities: Record<string, number>): { choice: string; margin: number } {
  let best = -1, second = -1, choice = "";
  for (const { id } of question.options) {
    const p = probabilities[id] ?? 0;
    if (p > best) { second = best; best = p; choice = id; }
    else if (p > second) second = p;
  }
  return { choice, margin: Math.max(0, best - Math.max(0, second)) };
}
