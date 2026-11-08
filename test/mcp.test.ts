import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { fakeServer, question, systemOneAnswer, tempDir } from "./fakes.ts";

const KEY = "SENTINEL-KEY-5d0b";

/** Spawn `adec mcp`, send the lines, close stdin and return the parsed responses. */
async function session(home: string, lines: unknown[]): Promise<any[]> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "adec.js"), "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ADEC_HOME: home } });
  proc.stdin.write(lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

test("AC9: initialize, tools/list and each tool over a spawned adec mcp; invalid input gives the CLI's usage message", async () => {
  const ok = fakeServer(body => "p1" in body.questions.decision.criteria ? systemOneAnswer({ p1: 0.9, p2: 0.1 }) : systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.1 }));
  const home = tempDir();
  const keyFile = join(home, "key.txt");
  writeFileSync(keyFile, KEY);
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: ok.url, model: "fake-1.0", keyFile, onPrem: true } } }));
  const bad = { ...question, options: [{ id: "only" }] };
  writeFileSync(join(home, "bad.json"), JSON.stringify(bad));
  mkdirSync(join(home, "policies"));
  writeFileSync(join(home, "policies", "chat.json"), JSON.stringify({ policyId: "chat", provider: "fake", instructions: "Pick.",
    candidates: [{ alias: "fast", efforts: ["low"], onPrem: true }, { alias: "big", efforts: ["high"], onPrem: true }], default: { alias: "big", effort: "high" } }));
  try {
    const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await session(home, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "adec_ask", { question, state: "STATE-SENTINEL" }),
      call(4, "adec_ask", { question: bad, state: "s" }),
      call(5, "adec_models", {}),
      call(6, "adec_shadow_report", {}),
      call(7, "adec_route", { request: { policyId: "missing", evidence: "", constraints: { contextTokens: 0 } } }),
      call(8, "adec_shadow_label", { id: "x", label: "y" }),
      call(9, "adec_route", { request: { policyId: "chat", evidence: "e", constraints: { contextTokens: 1 } } }),
    ]);
    const by = new Map(r.map(m => [m.id, m]));
    expect(by.get(1).result.serverInfo.name).toBe("adec");
    expect(by.get(2).result.tools.map((t: any) => t.name)).toEqual(["adec_ask", "adec_route", "adec_models", "adec_shadow_label", "adec_shadow_report"]);
    const decision = JSON.parse(by.get(3).result.content[0].text);
    expect(decision).toMatchObject({ choice: "implement", abstain: false });
    expect(by.get(4).result.isError).toBe(true);
    const err: string[] = [];
    await main(["ask", "--question", join(home, "bad.json"), "--state", "s"], { out: () => {}, err: s => err.push(s), env: { ADEC_HOME: home } });
    expect(`adec: ${by.get(4).result.content[0].text}`).toBe(err[0]!);
    expect(JSON.parse(by.get(5).result.content[0].text)[0]).toMatchObject({ name: "fake", model: "fake-1.0" });
    expect(JSON.parse(by.get(6).result.content[0].text).questions[0]).toMatchObject({ decisions: 1 });
    expect(by.get(7).result.isError).toBe(true);
    expect(by.get(8).result.isError).toBe(true);
    const routed = JSON.parse(by.get(9).result.content[0].text);
    expect(routed).toMatchObject({ alias: "fast", effort: "low", reason: "ok" });
    const labelled = await session(home, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      call(2, "adec_shadow_label", { id: routed.id, label: "completed" }),
      call(3, "adec_shadow_report", {}),
    ]);
    expect(JSON.parse(labelled.find(m => m.id === 2).result.content[0].text)).toMatchObject({ kind: "outcome", label: "completed" });
    expect(JSON.parse(labelled.find(m => m.id === 3).result.content[0].text).policies[0]).toMatchObject({ policyId: "chat", outcomes: { completed: 1 } });
    for (const m of r) expect(JSON.stringify(m)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain("STATE-SENTINEL");
  } finally { ok.stop(); }
});

test("AC8: an HTTP error echoing the key never reaches MCP output", async () => {
  const echo = fakeServer(() => new Response(`denied ${KEY}`, { status: 401 }));
  const home = tempDir();
  const keyFile = join(home, "key.txt");
  writeFileSync(keyFile, KEY);
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: echo.url, model: "fake-1.0", keyFile, onPrem: true } } }));
  try {
    const r = await session(home, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "adec_ask", arguments: { question, state: "s" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
    ]);
    expect(echo.seen).toHaveLength(1);
    expect(JSON.parse(r.find(m => m.id === 2).result.content[0].text)).toMatchObject({ abstain: true, reason: "http" });
    expect(r.find(m => m.id === 3).error.code).toBe(-32602);
    expect(JSON.stringify(r)).not.toContain(KEY);
  } finally { echo.stop(); }
});
