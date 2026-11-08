export const PACKAGE = "@staix/agent-decide";
export * from "./contract.ts";
export { adecHome, checkProvider, loadConfig, parseConfig, parseProvider, selectProvider, type Config, type ProviderConfig } from "./config.ts";
export { decide, type DecideOptions } from "./decide.ts";
export { evaluate, parseRows, type EvalReport, type EvalRow } from "./eval.ts";
export { labelOutcome, shadowReport, shadowDir } from "./shadow.ts";
