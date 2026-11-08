import { createHash, randomBytes } from "node:crypto";
import { readKey, type ProviderConfig } from "./config.ts";
import { parseMinMargin, topTwo, type AskRequest, type Decision, type ProviderAnswer, type Question, type Reason } from "./contract.ts";
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

/**
 * Ask one choice question. Every failure becomes an abstention with a closed reason; nothing is defaulted.
 * The question must already be parsed (parseQuestion).
 */
export async function decide(request: AskRequest, provider: ProviderConfig, options: DecideOptions): Promise<Decision & { error?: string }> {
  const { question, state } = request;
  const minMargin = parseMinMargin(request.minMargin);
  const id = randomBytes(16).toString("hex");
  const started = performance.now();
  let answer: ProviderAnswer | undefined, reason: Reason = "ok", error: string | undefined;

  if (state.length > provider.maxStateChars) reason = "state_too_long";
  // PII never reaches an off-prem provider: the request is not built and the key is not read.
  else if (request.pii && !provider.onPrem) reason = "off_prem";
  else {
    try {
      const key = await (options.key ?? readKey)(provider);
      answer = await call(provider, key, question, state);
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
    decider: { provider: provider.name, kind: provider.kind, model: answer?.model ?? provider.model, latencyMs },
  };
  if (options.shadowDir !== null) await appendDecision(options.shadowDir, question, decision, createHash("sha256").update(state).digest("hex"));
  return error === undefined ? decision : { ...decision, error };
}
