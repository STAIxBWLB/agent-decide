import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorLine, markerCell, resolveColor, wrap, type MarkerName } from "@staix/cli-output";
import { EXIT, main, type Io } from "../src/cli.ts";
import { tempDir } from "./fakes.ts";

const FIXTURES = join(import.meta.dir, "..", "node_modules", "@staix", "cli-output", "fixtures", "v1");
const fixture = (name: string): any[] => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const ESC = "\x1b";

/** Run main with captured streams; `terminal` marks which streams are TTYs. */
async function run(argv: string[], env: Record<string, string | undefined> = {}, terminal: Io["terminal"] = { out: false, err: false }) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { out: s => out.push(s), err: s => err.push(s), env: { ADEC_HOME: tempDir(), LANG: "en_US.UTF-8", ...env }, terminal });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("package fixtures v1 (color, markers, wrap, error-line) pass from the installed package", () => {
  for (const c of fixture("color.json")) {
    const got = resolveColor(c.flag, c.env, c.tool ?? "adec");
    if ("expectedError" in c) expect({ id: c.id, got: got instanceof Error ? got.message : got }).toEqual({ id: c.id, got: c.expectedError });
    else expect({ id: c.id, got }).toEqual({ id: c.id, got: c.expected });
  }
  for (const m of fixture("markers.json")) {
    expect(markerCell(m.name as MarkerName, false)).toBe(m.utf8);
    expect(markerCell(m.name as MarkerName, true)).toBe(m.ascii);
  }
  for (const w of fixture("wrap.json")) expect(wrap(w.input, w.columns, w.hang)).toEqual(w.expected);
  for (const e of fixture("error-line.json")) expect(errorLine(e.tool, e.what, e.why, e.options, e.columns)).toEqual(e.expected);
});

test("conformance 1: golden help with color off and with --color=always", async () => {
  const off = await run(["help"]);
  expect(off.code).toBe(EXIT.ok);
  expect(off.out.split("\n").slice(0, 5)).toEqual([
    "adec <command> [--color=auto|always|never]",
    "",
    "Commands",
    "  ask            ask one choice question; exit 0 decided, 3 abstained",
    "  eval           replay a labelled JSONL set; writes no shadow records",
  ]);
  const on = await run(["help", "--color=always"]);
  expect(on.out.split("\n")[0]).toBe("\x1b[1;34madec <command> [--color=auto|always|never]\x1b[0m");
  expect(on.out.split("\n")[2]).toBe("\x1b[1;35mCommands\x1b[0m");
  expect(on.out).toContain("  \x1b[34mask          \x1b[0m  ask one");
  expect(on.out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(off.out);
  const one = await run(["help", "ask"]);
  expect(one.out.split("\n")[0]).toBe("Usage");
  expect(one.out).toContain("adec ask --question FILE");
});

test("conformance 2: NO_COLOR with auto and --json emit no ESC; FORCE_COLOR on a pipe emits color", async () => {
  const tty = { out: true, err: true };
  expect((await run(["help", "--color=auto"], { NO_COLOR: "1" }, tty)).out).not.toContain(ESC);
  expect((await run(["providers", "--json"], { FORCE_COLOR: "1" }, tty)).out).not.toContain(ESC);
  expect((await run(["shadow", "report", "--json", "--color", "always"])).out).not.toContain(ESC);
  expect((await run(["help"], { FORCE_COLOR: "1" })).out).toContain(ESC);
  expect((await run(["help"], { TERM: "dumb" }, tty)).out).not.toContain(ESC);
  // Streams are decided separately: a TTY stderr is colored while piped stdout is not.
  const split = await run(["bogus"], {}, { out: false, err: true });
  expect(split.err).toStartWith("\x1b[1;31m✗ \x1b[0madec: unknown command");
});

test("conformance 3: at 80 columns no help line exceeds 80 cells", async () => {
  for (const argv of [["help"], ["help", "eval"], ["help", "calibrate"]]) {
    const r = await run(argv, { COLUMNS: "80" });
    for (const line of r.out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  }
  const wide = await run(["help"], {}, { out: true, err: true, columns: 80 });
  for (const line of wide.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

test("conformance 4: failing and usage exits keep adec: on stderr", async () => {
  const usage = await run(["ask", "--bogus"]);
  expect(usage.code).toBe(EXIT.usage);
  expect(usage.err).toStartWith("adec: ask: unknown option --bogus");
  expect(usage.out).toBe("");
  expect((await run([])).code).toBe(EXIT.usage);
  expect((await run(["help", "nope"])).code).toBe(EXIT.usage);
  const color = await run(["providers", "--color=sometimes"]);
  expect([color.code, color.err]).toEqual([EXIT.usage, "adec: --color: give auto, always or never"]);
  expect((await run(["providers", "--color=never", "--color=always"])).code).toBe(EXIT.usage);
  const home = tempDir();
  const missing = await run(["providers"], { ADEC_HOME: join(home, "nope") });
  expect(missing.code).not.toBe(EXIT.ok);
  expect(missing.err).toStartWith("adec: ");
});

test("conformance 5: LANG=C prints the ASCII markers", async () => {
  const tty = { out: true, err: true };
  expect((await run(["bogus"], { LANG: "C", NO_COLOR: "1" }, tty)).err).toStartWith("x adec: unknown command");
  expect((await run(["bogus"], { NO_COLOR: "1" }, tty)).err).toStartWith("✗ adec: unknown command");
});
