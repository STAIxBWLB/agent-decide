/** The single source of the CLI surface: help text is rendered from it and the parser reads its options. */
export interface CommandSpec { name: string; usage: string; summary: string; options: Record<string, "flag" | "value"> }
const json = { "--json": "flag" } as const;
export const COMMANDS: readonly CommandSpec[] = [
  { name: "ask", usage: "ask --question FILE (--state TEXT | --state-file FILE | --state -) [--pii] [--min-margin X] [--provider NAME] [--json]", summary: "ask one choice question; exit 0 decided, 3 abstained",
    options: { "--question": "value", "--state": "value", "--state-file": "value", "--pii": "flag", "--min-margin": "value", "--provider": "value", ...json } },
  { name: "eval", usage: "eval --question FILE --set FILE [--provider NAME] [--limit N] [--min-margin X] [--json]", summary: "replay a labelled JSONL set; writes no shadow records",
    options: { "--question": "value", "--set": "value", "--provider": "value", "--limit": "value", "--min-margin": "value", ...json } },
  { name: "calibrate", usage: "calibrate --question FILE --set FILE [--provider NAME] [--target-accuracy X] [--confirm] [--json]", summary: "fit a temperature and margin threshold on a labelled set; saves only with --confirm",
    options: { "--question": "value", "--set": "value", "--provider": "value", "--target-accuracy": "value", "--confirm": "flag", ...json } },
  { name: "route", usage: "route --request FILE|- [--json]", summary: "choose a model alias and effort from a policy; exit 0 picked, 3 no candidate",
    options: { "--request": "value", ...json } },
  { name: "serve", usage: "serve [--port N] [--host 127.0.0.1|::1]", summary: "loopback HTTP server: /v1/systemone, /v1/route, /v1/health; SIGHUP reloads",
    options: { "--port": "value", "--host": "value" } },
  { name: "mcp", usage: "mcp", summary: "stdio MCP server with the adec_* tools", options: {} },
  { name: "shadow label", usage: "shadow label <id> <label> [--json]", summary: "record the observed outcome of a decision or route", options: json },
  { name: "shadow report", usage: "shadow report [--json]", summary: "per-question decisions and per-policy routes with outcomes", options: json },
  { name: "providers", usage: "providers [--json]", summary: "list configured providers (never keys)", options: json },
  { name: "models", usage: "models [--json]", summary: "providers with pinned versions and calibration status", options: json },
];
