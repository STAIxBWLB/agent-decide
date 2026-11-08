// The public surface: entry points only. Each validates its inputs like the CLI (AGENTS.md, test/public-api.test.ts).
export const PACKAGE = "@staix/agent-decide";
export {
  MAX_OPTIONS, MIN_OPTIONS, OUTCOME_WORDS, UsageError, parseMinMargin, parseQuestion,
  type AskRequest, type Decider, type Decision, type Option, type Question, type Reason,
} from "./contract.ts";
export { adecHome, checkProvider, loadConfig, parseConfig, parseProvider, selectProvider, type Config, type ProviderConfig } from "./config.ts";
export { decide, type DecideOptions } from "./decide.ts";
export { evaluate, parseRows, type EvalReport, type EvalRow } from "./eval.ts";
export { labelOutcome, shadowReport, shadowDir } from "./shadow.ts";
