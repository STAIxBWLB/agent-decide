import pkg from "../package.json" with { type: "json" };
import { loadFits, type Fit } from "./calibrate.ts";
import { loadConfig, selectProvider, type Config, type ProviderConfig } from "./config.ts";
import { parseQuestion, UsageError } from "./contract.ts";
import { decide } from "./decide.ts";
import { readBodyBounded } from "./io.ts";
import { loadPolicies, type Policy } from "./policy.ts";
import { parseRouteRequest, PinStore, route } from "./route.ts";
import { shadowDir } from "./shadow.ts";

export const VERSION: string = pkg.version;
const BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

export interface ServeOptions {
  home: string;
  port?: number;
  host?: string;
  /** Operator log (stderr in the CLI): field names and causes only, never bodies. */
  log?: (line: string) => void;
  /** Injected for tests; defaults to reading each provider's key file. */
  key?: (provider: ProviderConfig) => Promise<string | undefined>;
}
export interface ServerHandle { url: string; port: number; reload(): Promise<boolean>; stop(): void }

interface Loaded { config: Config; policies: Map<string, Policy>; fits: Fit[] }
async function load(home: string): Promise<Loaded> {
  const config = await loadConfig(home);
  return { config, policies: await loadPolicies(home, config), fits: await loadFits(home) };
}

function obj(raw: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${where}: expected a JSON object`);
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) throw new UsageError(`${where}: unknown field ${unknown.map(k => JSON.stringify(k)).join(", ")}; allowed fields are ${allowed.join(", ")}`);
  return raw as Record<string, unknown>;
}

const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, error: string) => reply(status, { error });

/** A System One request with the adec extension, as a D1 ask request. */
function parseSystemOne(raw: unknown) {
  const b = obj(raw, ["model", "state", "questions", "adec"], "request");
  if (b.model !== undefined && typeof b.model !== "string") throw new UsageError("request.model: name a provider from config.json, or leave it out for the default");
  if (typeof b.state !== "string") throw new UsageError("request.state: give the state as a string");
  const qs = obj(b.questions, ["decision"], "request.questions");
  const q = obj(qs.decision, ["type", "instructions", "criteria"], "request.questions.decision");
  if (q.type !== "choice") throw new UsageError("request.questions.decision.type: only \"choice\" questions are accepted in this phase");
  const criteria = obj(q.criteria, Object.keys(q.criteria ?? {}), "request.questions.decision.criteria");
  const a = obj(b.adec, ["questionId", "pii", "minMargin"], "request.adec");
  const question = parseQuestion({
    questionId: a.questionId, instructions: q.instructions,
    options: Object.entries(criteria).map(([id, d]) => (d === null ? { id } : { id, description: d })),
  });
  return { model: b.model as string | undefined, ask: { question, state: b.state, ...(a.pii === undefined ? {} : { pii: a.pii as boolean }), ...(a.minMargin === undefined ? {} : { minMargin: a.minMargin as number }) } };
}

/**
 * Loopback HTTP server: POST /v1/systemone, POST /v1/route, GET /v1/health. No authentication, so it binds loopback only
 * and refuses browser-shaped requests (an Origin header, a foreign Host) to block DNS rebinding and cross-site posts.
 */
export async function serve(options: ServeOptions): Promise<ServerHandle> {
  const o = obj(options, ["home", "port", "host", "log", "key"], "serve options");
  if (typeof o.home !== "string" || !o.home) throw new UsageError("serve options.home: give the ADEC_HOME directory");
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(host)) throw new UsageError(`serve: --host must be 127.0.0.1 or ::1; the server has no authentication, so it never binds ${host}`);
  const port = options.port ?? 8740;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("serve: --port must be an integer from 0 to 65535");
  if (o.log !== undefined && typeof o.log !== "function") throw new UsageError("serve options.log: give a function or leave it out");
  if (o.key !== undefined && typeof o.key !== "function") throw new UsageError("serve options.key: give a function or leave it out");
  const log = options.log ?? (() => {});
  let state = await load(options.home);
  const pins = new PinStore();
  const shadow = shadowDir(options.home), key = options.key ? { key: options.key } : {};

  async function handle(req: Request, hosts: Set<string>): Promise<Response> {
    if (req.headers.has("origin")) return refuse(403, "requests with an Origin header are refused; call the server from a local program, not a browser");
    if (!hosts.has(req.headers.get("host") ?? "")) return refuse(403, "the Host header must be the loopback address and port the server listens on");
    const path = new URL(req.url).pathname;
    if (path === "/v1/health") return req.method === "GET" ? reply(200, { ok: true, version: VERSION }) : refuse(405, "use GET");
    if (path !== "/v1/systemone" && path !== "/v1/route") return refuse(404, "unknown path; use /v1/systemone, /v1/route or /v1/health");
    if (req.method !== "POST") return refuse(405, "use POST");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return refuse(415, "send the body as application/json");
    if (Number(req.headers.get("content-length") ?? 0) > BODY_BYTES) return refuse(413, `the body is larger than ${BODY_BYTES} bytes`);
    const text = await readBodyBounded(req, BODY_BYTES);
    if (text === undefined) return refuse(413, `the body is larger than ${BODY_BYTES} bytes`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return refuse(400, "the body is not valid JSON"); }
    const { config, policies, fits } = state;
    if (path === "/v1/systemone") {
      const { model, ask } = parseSystemOne(body);
      const provider = selectProvider(config, model);
      const d = await decide(ask, provider, { shadowDir: shadow, fits, ...key });
      return reply(200, { model: provider.model, answers: { decision: { type: "choice", choice: d.choice, probabilities: d.probabilities, confidence: d.margin } }, adec: d });
    }
    const request = parseRouteRequest(body);
    const policy = policies.get(request.policyId);
    if (!policy) return refuse(404, `no policy ${request.policyId} in ADEC_HOME/policies; add the file and reload (SIGHUP)`);
    return reply(200, await route(request, policy, selectProvider(config, policy.provider), { shadowDir: shadow, pins, ...key }));
  }

  let hosts = new Set<string>();
  const server = Bun.serve({
    hostname: host, port,
    async fetch(req) {
      try { return await handle(req, hosts); }
      catch (e) {
        if (e instanceof UsageError) return refuse(400, e.message);
        log(`adec serve: unexpected ${e instanceof Error ? e.name : "error"} on ${new URL(req.url).pathname}`);
        return refuse(500, "unexpected server error; the operator log names the class");
      }
    },
  });
  const bound = server.port!;
  hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`]);
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${bound}`, port: bound,
    /** Re-read configuration, policies and fits; a bad file keeps the previous set. */
    async reload() {
      try { state = await load(options.home); log("adec serve: reloaded configuration, policies and fits"); return true; }
      catch (e) { log(`adec serve: reload refused, keeping the previous set: ${e instanceof UsageError ? e.message : "unreadable files"}`); return false; }
    },
    stop() { server.stop(true); },
  };
}
