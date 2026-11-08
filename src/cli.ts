import { join } from "node:path";
import { appendFit, calibrate, loadFits, modelsReport, parseTargetAccuracy } from "./calibrate.ts";
import { COMMANDS, type CommandSpec } from "./commands-table.ts";
import { adecHome, loadConfig, selectProvider } from "./config.ts";
import { parseMinMargin, parseQuestion, UsageError } from "./contract.ts";
import { decide } from "./decide.ts";
import { evaluate, parseRows } from "./eval.ts";
import { readJsonBounded, readStdinBounded, readTextBounded } from "./io.ts";
import { serveMcp } from "./mcp.ts";
import { loadPolicy } from "./policy.ts";
import { parseRouteRequest, route } from "./route.ts";
import { serve } from "./serve.ts";
import { labelOutcome, routeReport, shadowDir, shadowReport } from "./shadow.ts";

const QUESTION_BYTES = 64 * 1024, REQUEST_BYTES = 1024 * 1024, STATE_BYTES = 1024 * 1024, SET_BYTES = 64 * 1024 * 1024;
export const EXIT = { ok: 0, error: 1, usage: 2, abstained: 3 } as const;

export interface Io { out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined> }
const defaultIo: Io = { out: s => console.log(s), err: s => console.error(s), env: process.env };

function help(): string {
  return ["usage: adec <command>", "", ...COMMANDS.map(c => `  adec ${c.usage}\n      ${c.summary}`), "", "Configuration: $ADEC_HOME/config.json (default ~/.adec)."].join("\n");
}

interface Parsed { spec: CommandSpec; positional: string[]; values: Record<string, string>; flags: Set<string> }

export function parseArgs(argv: string[]): Parsed {
  const spec = [...COMMANDS].sort((a, b) => b.name.split(" ").length - a.name.split(" ").length)
    .find(c => c.name.split(" ").every((w, i) => argv[i] === w));
  if (!spec) throw new UsageError(argv.length ? `unknown command ${JSON.stringify(argv.slice(0, 2).join(" "))}; run adec help` : "no command; run adec help");
  const rest = argv.slice(spec.name.split(" ").length);
  const positional: string[] = [], values: Record<string, string> = {}, flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const kind = spec.options[a];
    if (!kind) throw new UsageError(`${spec.name}: unknown option ${a}; usage: adec ${spec.usage}`);
    if (kind === "flag") { flags.add(a); continue; }
    const v = rest[++i];
    if (v === undefined) throw new UsageError(`${spec.name}: ${a} needs a value; usage: adec ${spec.usage}`);
    if (a in values) throw new UsageError(`${spec.name}: ${a} given twice`);
    values[a] = v;
  }
  return { spec, positional, values, flags };
}

function need(p: Parsed, option: string): string {
  const v = p.values[option];
  if (v === undefined) throw new UsageError(`${p.spec.name}: ${option} is required; usage: adec ${p.spec.usage}`);
  return v;
}

function noPositional(p: Parsed, count = 0) {
  if (p.positional.length !== count) throw new UsageError(`${p.spec.name}: expected ${count} argument(s); usage: adec ${p.spec.usage}`);
}

async function state(p: Parsed): Promise<string> {
  const inline = p.values["--state"], file = p.values["--state-file"];
  if ((inline === undefined) === (file === undefined)) throw new UsageError("ask: give exactly one of --state TEXT, --state-file FILE or --state -");
  if (file !== undefined) return readTextBounded(file, STATE_BYTES, "state file");
  return inline === "-" ? readStdinBounded(STATE_BYTES, "state") : inline!;
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new UsageError(`${what}: not valid JSON`); }
}

const fmt = (n: number | null, digits = 3) => (n === null ? "-" : n.toFixed(digits));

async function run(p: Parsed, io: Io): Promise<number> {
  const home = adecHome(io.env), asJson = p.flags.has("--json");
  const print = (value: unknown, text: string) => io.out(asJson ? JSON.stringify(value, null, 2) : text);
  switch (p.spec.name) {
    case "ask": {
      noPositional(p);
      const question = parseQuestion(await readJsonBounded(need(p, "--question"), QUESTION_BYTES, "question file"));
      const minMargin = parseMinMargin(p.values["--min-margin"]);
      const provider = selectProvider(await loadConfig(home), p.values["--provider"]);
      const asked = p.values["--min-margin"] === undefined ? {} : { minMargin };
      const d = await decide({ question, state: await state(p), pii: p.flags.has("--pii"), ...asked }, provider, { shadowDir: shadowDir(home), fits: await loadFits(home) });
      print(d, d.abstain
        ? `abstain (${d.reason})${d.error ? `: ${d.error}` : ""}\nid ${d.id}`
        : `${d.choice} (margin ${fmt(d.margin)}${d.calibration ? `, calibrated ${d.calibration.fittedAt}` : ""}, ${d.decider.provider}/${d.decider.model}, ${d.decider.latencyMs} ms)\nid ${d.id}`);
      return d.abstain ? EXIT.abstained : EXIT.ok;
    }
    case "eval": {
      noPositional(p);
      const question = parseQuestion(await readJsonBounded(need(p, "--question"), QUESTION_BYTES, "question file"));
      const rows = parseRows(await readTextBounded(need(p, "--set"), SET_BYTES, "set file"), question);
      const limitRaw = p.values["--limit"];
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new UsageError("eval: --limit must be a positive integer");
      const provider = selectProvider(await loadConfig(home), p.values["--provider"]);
      const r = await evaluate(question, rows, provider, { minMargin: parseMinMargin(p.values["--min-margin"]), ...(limit === undefined ? {} : { limit }) });
      print(r, [
        `${r.questionId} on ${r.provider}/${r.model}: n ${r.n}, skipped ${r.skipped}, answered ${r.answered}`,
        `accuracy ${fmt(r.accuracy)}  coverage ${fmt(r.coverage)}  macro-F1 ${fmt(r.macroF1)}  ECE ${fmt(r.ece)}  Brier ${fmt(r.brier)}`,
        `latency p50 ${r.latencyMs.p50 ?? "-"} ms, p95 ${r.latencyMs.p95 ?? "-"} ms; abstained ${JSON.stringify(r.abstained)}`,
      ].join("\n"));
      return EXIT.ok;
    }
    case "calibrate": {
      noPositional(p);
      const question = parseQuestion(await readJsonBounded(need(p, "--question"), QUESTION_BYTES, "question file"));
      const rows = parseRows(await readTextBounded(need(p, "--set"), SET_BYTES, "set file"), question);
      const targetAccuracy = parseTargetAccuracy(p.values["--target-accuracy"]);
      const provider = selectProvider(await loadConfig(home), p.values["--provider"]);
      const fit = await calibrate(question, rows, provider, { targetAccuracy });
      const saved = p.flags.has("--confirm");
      if (saved) await appendFit(home, fit);
      const m = (x: typeof fit.metrics.raw) => `accuracy ${fmt(x.accuracy)}  coverage ${fmt(x.coverage)}  selective ${fmt(x.selectiveAccuracy)}  ECE ${fmt(x.ece)}  Brier ${fmt(x.brier)}`;
      print({ fit, saved }, [
        `${fit.questionId} on ${fit.provider}/${fit.model}: n ${fit.n}, temperature ${fmt(fit.temperature)}, min margin ${fmt(fit.minMargin)} (target accuracy ${fmt(fit.targetAccuracy, 2)})`,
        `held-out ${fit.metrics.raw.n} raw:        ${m(fit.metrics.raw)}`,
        `held-out ${fit.metrics.raw.n} calibrated: ${m(fit.metrics.calibrated)}`,
        saved ? "saved; adec ask and adec serve apply it from the next call" : "preview only; rerun with --confirm to save the fit",
      ].join("\n"));
      return EXIT.ok;
    }
    case "route": {
      noPositional(p);
      const file = need(p, "--request");
      const request = parseRouteRequest(file === "-" ? parseJson(await readStdinBounded(REQUEST_BYTES, "route request"), "route request") : await readJsonBounded(file, REQUEST_BYTES, "route request file"));
      const config = await loadConfig(home);
      const policy = await loadPolicy(home, request.policyId, config);
      const r = await route(request, policy, selectProvider(config, policy.provider), { shadowDir: shadowDir(home) });
      print(r, r.alias === null
        ? `no candidate (rules ${r.rules.join(", ") || "none"}); keep the current route\nid ${r.id}`
        : `${r.alias} ${r.effort} (${r.reason}${r.fallbackApplied ? ", fallback" : ""}${r.rules.length ? `, rules ${r.rules.join(", ")}` : ""})\nid ${r.id}`);
      return r.alias === null ? EXIT.abstained : EXIT.ok;
    }
    case "serve": {
      noPositional(p);
      const portRaw = p.values["--port"];
      const port = portRaw === undefined ? undefined : Number(portRaw);
      if (port !== undefined && !Number.isInteger(port)) throw new UsageError("serve: --port must be an integer from 0 to 65535");
      const s = await serve({ home, ...(port === undefined ? {} : { port }), ...(p.values["--host"] === undefined ? {} : { host: p.values["--host"] }), log: io.err });
      const reload = () => { void s.reload(); };
      // Handlers go in before the listening line: a supervisor may signal as soon as it reads it.
      const stopped = new Promise<void>(resolve => { const stop = () => { process.off("SIGHUP", reload); s.stop(); resolve(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
      process.on("SIGHUP", reload);
      io.out(`adec serve: listening on ${s.url} (SIGHUP reloads, SIGINT stops)`);
      await stopped;
      return EXIT.ok;
    }
    case "mcp": {
      noPositional(p);
      await serveMcp(home);
      return EXIT.ok;
    }
    case "models": {
      noPositional(p);
      const list = modelsReport(await loadConfig(home), await loadFits(home));
      print(list, list.map(x => [`${x.name}${x.default ? " (default)" : ""}: ${x.kind} ${x.model}${x.version ? ` ${x.version}` : ""} ${x.onPrem ? "on-prem" : "off-prem"}${x.sha256 ? ` sha256 ${x.sha256.slice(0, 12)}` : ""}`,
        ...x.fits.map(f => `  ${f.questionId}: ${f.status} ${f.fittedAt} (temperature ${fmt(f.temperature)}, min margin ${fmt(f.minMargin)})`)].join("\n")).join("\n"));
      return EXIT.ok;
    }
    case "shadow label": {
      noPositional(p, 2);
      const row = await labelOutcome(shadowDir(home), p.positional[0]!, p.positional[1]!);
      print(row, `labelled ${row.id} ${row.label}`);
      return EXIT.ok;
    }
    case "shadow report": {
      noPositional(p);
      const questions = await shadowReport(shadowDir(home)), policies = await routeReport(shadowDir(home));
      const lines = [
        ...questions.map(q => `${q.questionId}: ${q.decisions} decisions, abstained ${JSON.stringify(q.abstained)}, labelled ${q.labelled}, agreement ${fmt(q.agreement)}`),
        ...policies.map(r => `policy ${r.policyId}: ${r.routes} routes, by reason ${JSON.stringify(r.byReason)}, fallback ${r.fallbackApplied}, pinned ${r.pinned}, labelled ${r.labelled} ${JSON.stringify(r.outcomes)}`),
      ];
      print({ questions, policies }, lines.length ? lines.join("\n") : `no decisions or routes in ${join(home, "shadow")}`);
      return EXIT.ok;
    }
    case "providers": {
      noPositional(p);
      const config = await loadConfig(home);
      const list = Object.values(config.providers).map(({ name, kind, model, onPrem, endpoint }) => ({ name, kind, model, onPrem, endpoint, default: name === config.default }));
      print(list, list.map(x => `${x.name}${x.default ? " (default)" : ""}: ${x.kind} ${x.model} ${x.onPrem ? "on-prem" : "off-prem"} ${x.endpoint}`).join("\n"));
      return EXIT.ok;
    }
  }
  throw new UsageError(`unhandled command ${p.spec.name}`);
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { io.out(help()); return argv.length ? EXIT.ok : EXIT.usage; }
  try { return await run(parseArgs(argv), io); }
  catch (e) {
    if (e instanceof UsageError) { io.err(`adec: ${e.message}`); return EXIT.usage; }
    io.err(`adec: unexpected error (${e instanceof Error ? e.name : "unknown"}); rerun with the same arguments and report the command if it repeats`);
    return EXIT.error;
  }
}
