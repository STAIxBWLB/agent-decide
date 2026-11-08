// The public surface: entry points only. Each validates its inputs like the CLI (AGENTS.md, test/public-api.test.ts).
export const PACKAGE = "@staix/agent-decide";
export {
  MAX_OPTIONS, MIN_OPTIONS, OUTCOME_WORDS, UsageError, parseMinMargin, parseQuestion,
  type AskRequest, type Decider, type Decision, type Option, type Question, type Reason,
} from "./contract.ts";
export { adecHome, checkProvider, loadConfig, parseConfig, parseProvider, selectProvider, type Config, type ProviderConfig } from "./config.ts";
export { decide, type DecideOptions } from "./decide.ts";
export { compareRows, evaluate, parseRows, type CompareOptions, type CompareReport, type EvalOptions, type EvalReport, type EvalRow, type EvalRowResult } from "./eval.ts";
export { labelOutcome, routeReport, shadowReport, shadowDir } from "./shadow.ts";
export { calibrate, loadFits, type Fit, type SplitMetrics } from "./calibrate.ts";
export { parsePolicy, type Candidate, type Pair, type Policy } from "./policy.ts";
export { parseRouteRequest, route, type RouteDecision, type RouteReason, type RouteRequest, type RouteRule } from "./route.ts";
export { serve, type ServeOptions, type ServerHandle } from "./serve.ts";
