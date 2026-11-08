import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { loadFits, modelsReport } from "./calibrate.ts";
import { loadConfig, selectProvider } from "./config.ts";
import { parseMinMargin, parseQuestion, unknownFields, UsageError } from "./contract.ts";
import { decide } from "./decide.ts";
import { loadPolicy } from "./policy.ts";
import { parseRouteRequest, route } from "./route.ts";
import { VERSION } from "./serve.ts";
import { labelOutcome, routeReport, shadowDir, shadowReport } from "./shadow.ts";

/** Newline-delimited JSON-RPC 2.0 over stdio, tools only (the family's hand-rolled MCP; framing as in vault-mem). */
export const FRAME_BYTES = 1024 * 1024;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = { type: "string" } as const;

export const TOOLS = [
  { name: "adec_ask", description: "Ask one choice question; returns the decision with probabilities, margin and abstention. A proposal, never an action.",
    inputSchema: { type: "object", additionalProperties: false, required: ["question", "state"],
      properties: { question: { type: "object" }, state: str, pii: { type: "boolean" }, minMargin: { type: "number" }, provider: str } } },
  { name: "adec_route", description: "Choose a model alias and effort from a routing policy (no pins: pins live in adec serve).",
    inputSchema: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "object" } } } },
  { name: "adec_models", description: "Configured providers with pinned versions and calibration status (never keys).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "adec_shadow_label", description: "Record the observed outcome of a decision or route by its id.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: str, label: str } } },
  { name: "adec_shadow_report", description: "Per-question decisions and per-policy routes with their outcome labels.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
] as const;

function args(raw: Record<string, unknown>, allowed: readonly string[], tool: string): Record<string, unknown> {
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) throw new UsageError(`${tool}: ${unknownFields(unknown, allowed, "argument")}`);
  return raw;
}

/** Tool handlers; every input goes through the CLI's parse/check functions. */
export function handlers(home: string): Record<string, (a: Record<string, unknown>) => Promise<unknown>> {
  return {
    async adec_ask(raw) {
      const a = args(raw, ["question", "state", "pii", "minMargin", "provider"], "adec_ask");
      if (a.provider !== undefined && typeof a.provider !== "string") throw new UsageError("adec_ask: provider must be a provider name");
      const config = await loadConfig(home);
      const provider = selectProvider(config, a.provider as string | undefined);
      return decide({ question: parseQuestion(a.question), state: a.state as string, ...(a.pii === undefined ? {} : { pii: a.pii as boolean }),
        ...(a.minMargin === undefined ? {} : { minMargin: parseMinMargin(a.minMargin) }) }, provider, { shadowDir: shadowDir(home), fits: await loadFits(home) });
    },
    async adec_route(raw) {
      const request = parseRouteRequest(args(raw, ["request"], "adec_route").request);
      const config = await loadConfig(home);
      const policy = await loadPolicy(home, request.policyId, config);
      return route(request, policy, selectProvider(config, policy.provider), { shadowDir: shadowDir(home) });
    },
    async adec_models(raw) { args(raw, [], "adec_models"); return modelsReport(await loadConfig(home), await loadFits(home)); },
    async adec_shadow_label(raw) {
      const a = args(raw, ["id", "label"], "adec_shadow_label");
      return labelOutcome(shadowDir(home), a.id as string, a.label as string);
    },
    async adec_shadow_report(raw) {
      args(raw, [], "adec_shadow_report");
      return { questions: await shadowReport(shadowDir(home)), policies: await routeReport(shadowDir(home)) };
    },
  };
}

/** Serve until input ends. stdout carries protocol messages only. */
export async function serveMcp(home: string, input: Readable | AsyncIterable<Uint8Array | string> = process.stdin, output: Writable = process.stdout): Promise<void> {
  const tools = handlers(home);
  let phase: "new" | "initializing" | "ready" = "new";
  const send = async (response: unknown) => { if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain"); };
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const handle = async (line: string) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { await error(null, -32700, "Parse error"); return; }
    if (!plain(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { await error(null, -32600, "Invalid request"); return; }
    if (!Object.hasOwn(msg, "id")) {
      if (msg.method === "notifications/initialized" && phase === "initializing") phase = "ready";
      return;
    }
    const id = msg.id;
    if (!(typeof id === "string" && id.length <= 200 || typeof id === "number" && Number.isSafeInteger(id))) { await error(null, -32600, "Invalid request id"); return; }
    if (msg.method === "ping") { await send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (msg.method === "initialize") {
      if (phase !== "new" || !plain(msg.params) || typeof msg.params.protocolVersion !== "string") { await error(id, -32602, "Invalid initialization"); return; }
      phase = "initializing";
      await send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOLS.includes(msg.params.protocolVersion) ? msg.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "adec", version: VERSION } } });
      return;
    }
    if (phase !== "ready") { await error(id, -32002, "Initialize the session first"); return; }
    if (msg.method === "tools/list") { await send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
    if (msg.method !== "tools/call") { await error(id, -32601, "Method not found"); return; }
    const params = msg.params;
    if (!plain(params) || typeof params.name !== "string" || (params.arguments !== undefined && !plain(params.arguments))) { await error(id, -32602, "Invalid tool call"); return; }
    const handler = Object.hasOwn(tools, params.name) ? tools[params.name] : undefined;
    if (!handler) { await error(id, -32602, "unknown tool; see tools/list"); return; }
    let result: unknown;
    try { result = { content: [{ type: "text", text: JSON.stringify(await handler((params.arguments ?? {}) as Record<string, unknown>)) }] }; }
    catch (failure) {
      // Usage errors carry the CLI's message (field and fix, never content); anything else is named by class only.
      const text = failure instanceof UsageError ? failure.message : `unexpected error (${failure instanceof Error ? failure.name : "unknown"})`;
      result = { isError: true, content: [{ type: "text", text }] };
    }
    await send({ jsonrpc: "2.0", id, result });
  };
  let pending = "", overflow = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const consume = async (chunk: string) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start), part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (!overflow) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > FRAME_BYTES) { overflow = true; pending = ""; }
        else pending += part;
      }
      if (newline < 0) return;
      if (overflow) await error(null, -32600, `Request exceeds the ${FRAME_BYTES}-byte frame bound`);
      else if (pending.trim()) await handle(pending);
      pending = ""; overflow = false; start = newline + 1;
    }
  };
  try {
    for await (const chunk of input) await consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  } catch { await error(null, -32700, "Invalid UTF-8 input"); return; }
  await consume(decoder.decode());
  if (pending.trim() || overflow) await error(null, -32700, "Incomplete request at EOF");
}
