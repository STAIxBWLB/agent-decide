import { createHash, randomBytes } from "node:crypto";
import { checkProvider, readKey, type ProviderConfig } from "./config.ts";
import { parseMinMargin, parseQuestion, topTwo, UsageError, type AskRequest, type Decision, type ProviderAnswer, type Question, type Reason } from "./contract.ts";
import { ProviderError } from "./providers/http.ts";
import { askLogits } from "./providers/logits.ts";
import { askSystemOne } from "./providers/systemone.ts";
import { appendDecision } from "./shadow.ts";

export interface DecideOptions {
  /** Shadow log directory; null writes nothing (eval). */
  shadowDir: string | null;
  /** Injected for tests; defaults to reading the provider's key file. */
  key?: (provider: ProviderConfig) => Promise<string | undefined>;
}

function call(provider: ProviderConfig, key: string | undefined, question: Question, state: string): Promise<ProviderAnswer> {
  return provider.kind === "systemone" ? askSystemOne(provider, key, question, state) : askLogits(provider, key, question, state);
}

/** Library entry point validation: the same rules the CLI applies, so CLI and library cannot diverge. */
function parseAskRequest(raw: AskRequest): { question: Question; state: string; minMargin: number } {
  if (typeof raw !== "object" || raw === null) throw new UsageError("request: expected an object with question and state");
  const unknown = Object.keys(raw).filter(k => !["question", "state", "pii", "minMargin"].includes(k));
  if (unknown.length) throw new UsageError(`request: unknown field ${unknown.join(", ")}; allowed fields are question, state, pii, minMargin`);
  if (typeof raw.state !== "string") throw new UsageError("request.state: give the state as a string");
  if (raw.pii !== undefined && typeof raw.pii !== "boolean") throw new UsageError("request.pii: give true or false");
  return { question: parseQuestion(raw.question), state: raw.state, minMargin: parseMinMargin(raw.minMargin) };
}

function checkOptions(options: DecideOptions): void {
  if (typeof options !== "object" || options === null) throw new UsageError("options: give { shadowDir: string | null }");
  const unknown = Object.keys(options).filter(k => k !== "shadowDir" && k !== "key");
  if (unknown.length) throw new UsageError(`options: unknown field ${unknown.join(", ")}; allowed fields are shadowDir, key`);
  if (options.shadowDir !== null && (typeof options.shadowDir !== "string" || !options.shadowDir)) throw new UsageError("options.shadowDir: give a directory path, or null to write no shadow record");
  if (options.key !== undefined && typeof options.key !== "function") throw new UsageError("options.key: give a function or leave it out");
}

/** One invariant for every provider: probabilities are finite, in [0, 1], cover exactly the options and sum to 1. */
function checkAnswer(provider: ProviderConfig, question: Question, answer: ProviderAnswer): ProviderAnswer {
  const ids = question.options.map(o => o.id), probs = answer.probabilities;
  const ok = Object.keys(probs).length === ids.length && ids.every(id => {
    const p = probs[id];
    return Object.hasOwn(probs, id) && typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
  }) && Math.abs(ids.reduce((s, id) => s + probs[id]!, 0) - 1) <= 0.001;
  if (!ok) throw new ProviderError("malformed", provider.name, "probabilities are not a distribution over the options");
  return answer;
}

/**
 * Ask one choice question. Every failure becomes an abstention with a closed reason; nothing is defaulted.
 * The question and request are validated here (UsageError), so library callers get the CLI's rules.
 */
export async function decide(request: AskRequest, provider: ProviderConfig, options: DecideOptions): Promise<Decision & { error?: string }> {
  const { question, state, minMargin } = parseAskRequest(request);
  provider = checkProvider(provider);
  checkOptions(options);
  const id = randomBytes(16).toString("hex");
  const started = performance.now();
  let answer: ProviderAnswer | undefined, reason: Reason = "ok", error: string | undefined;

  if (state.length > provider.maxStateChars) reason = "state_too_long";
  // PII never reaches an off-prem provider: the request is not built and the key is not read.
  else if (request.pii && !provider.onPrem) reason = "off_prem";
  else {
    try {
      const key = await (options.key ?? readKey)(provider);
      answer = checkAnswer(provider, question, await call(provider, key, question, state));
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      reason = e.reason;
      error = e.message;
    }
  }

  const latencyMs = Math.round(performance.now() - started);
  let choice: string | null = null, margin = 0;
  if (answer) {
    const top = topTwo(question, answer.probabilities);
    margin = top.margin;
    if (margin < minMargin) reason = "low_margin";
    else choice = top.choice;
  }
  const decision: Decision = {
    id, questionId: question.questionId, choice, probabilities: answer?.probabilities ?? {}, margin,
    abstain: choice === null, reason,
    ...(answer?.labelMass === undefined ? {} : { labelMass: answer.labelMass }),
    decider: { provider: provider.name, kind: provider.kind, model: provider.model, latencyMs },
  };
  if (options.shadowDir !== null) await appendDecision(options.shadowDir, question, decision, createHash("sha256").update(state).digest("hex"));
  return error === undefined ? decision : { ...decision, error };
}
