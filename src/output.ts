// The one human-output module (#10, CLI output standard v1 via @staix/cli-output). Color, markers, wrapping and
// error lines come from the package; no other file in src/ imports it or writes terminal codes (scripts/check-boundary.ts).
import { asciiMarkers, cellWidth, errorSpans, paint, resolveColor, streamEnv, streamWidth, wrap, type Span } from "@staix/cli-output";

export const TOOL = "adec";

/** Decided once per run and per stream: stdout and stderr each get their own color decision. */
export interface OutputPolicy { color: { out: boolean; err: boolean }; ascii: boolean; width: number | undefined; tty: { out: boolean; err: boolean } }

export interface Terminal { out: boolean; err: boolean; columns?: number }

/** Resolve `--color` (undefined = auto) against the environment; an invalid value is returned as an Error. */
export function outputPolicy(flag: string | undefined, env: Record<string, string | undefined>, tty: Terminal): OutputPolicy | Error {
  const out = resolveColor(flag, streamEnv(tty.out, env), TOOL), err = resolveColor(flag, streamEnv(tty.err, env), TOOL);
  if (out instanceof Error) return out;
  if (err instanceof Error) return err;
  return { color: { out, err }, ascii: asciiMarkers(env), width: streamWidth(tty.out, tty.columns, env), tty: { out: tty.out, err: tty.err } };
}

/** Human text for stdout: terminal sequences removed, wrapped to the stream width when one is known. */
export function text(value: string, policy: OutputPolicy): string {
  return wrap(value, policy.width).join("\n");
}

/** `adec: <message>` on stderr, with the fail marker when stderr is a TTY (piped stderr keeps the plain form). */
export function errorText(message: string, policy: OutputPolicy): string {
  return errorSpans(TOOL, message, "", { tty: policy.tty.err, ascii: policy.ascii }, policy.tty.err ? policy.width : undefined)
    .map(line => paint(line, policy.color.err)).join("\n");
}

/** Help overview: command groups as two aligned columns `  <name>  <summary>`, summaries wrapped under their column. */
export function helpOverview(commands: readonly { name: string; summary: string }[], footer: string, policy: OutputPolicy): string {
  const width = policy.width ?? 80, nameWidth = Math.max(...commands.map(c => cellWidth(c.name)));
  const lines: Span[][] = [[{ text: `${TOOL} <command> [--color=auto|always|never]`, role: "header" }], [], [{ text: "Commands", role: "section" }]];
  for (const c of commands) {
    const lead = 2 + nameWidth + 2;
    const wrapped = wrap(`${" ".repeat(lead)}${c.summary}`, width, 0);
    wrapped.forEach((line, i) => lines.push(i ? [{ text: line }] : [{ text: "  " }, { text: c.name.padEnd(nameWidth), role: "key" }, { text: line.slice(2 + nameWidth) }]));
  }
  lines.push([], ...wrap(footer, width, 0).map(line => [{ text: line, role: "hint" as const }]));
  return lines.map(line => paint(line, policy.color.out)).join("\n");
}

/** `adec help <command>`: its usage form and summary. */
export function helpCommand(command: { usage: string; summary: string }, policy: OutputPolicy): string {
  return [[{ text: "Usage", role: "section" as const }], [{ text: wrap(`  ${TOOL} ${command.usage}`, policy.width ?? 80, 4).join("\n") }], [{ text: wrap(`  ${command.summary}`, policy.width ?? 80, 0).join("\n") }]]
    .map(line => paint(line, policy.color.out)).join("\n");
}
