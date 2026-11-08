/** The single source of the CLI surface: help text is rendered from it and the parser reads its options. */
export interface CommandSpec { name: string; usage: string; summary: string; options: Record<string, "flag" | "value"> }
const json = { "--json": "flag" } as const;
export const COMMANDS: readonly CommandSpec[] = [
  { name: "ask", usage: "ask --question FILE (--state TEXT | --state-file FILE | --state -) [--pii] [--min-margin X] [--provider NAME] [--json]", summary: "ask one choice question; exit 0 decided, 3 abstained",
    options: { "--question": "value", "--state": "value", "--state-file": "value", "--pii": "flag", "--min-margin": "value", "--provider": "value", ...json } },
  { name: "eval", usage: "eval --question FILE --set FILE [--provider NAME] [--limit N] [--min-margin X] [--json]", summary: "replay a labelled JSONL set; writes no shadow records",
    options: { "--question": "value", "--set": "value", "--provider": "value", "--limit": "value", "--min-margin": "value", ...json } },
  { name: "shadow label", usage: "shadow label <id> <label> [--json]", summary: "record the observed outcome of a decision", options: json },
  { name: "shadow report", usage: "shadow report [--json]", summary: "per-question decisions, abstentions and agreement with outcomes", options: json },
  { name: "providers", usage: "providers [--json]", summary: "list configured providers (never keys)", options: json },
];
