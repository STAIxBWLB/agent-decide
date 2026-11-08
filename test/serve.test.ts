import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../src/contract.ts";
import { serve } from "../src/serve.ts";
import { fakeServer, question, systemOneAnswer, tempDir } from "./fakes.ts";

const KEY = "SENTINEL-KEY-9c1e";
const POLICY = {
  policyId: "test.chat", provider: "fake", instructions: "INSTRUCTIONS-SENTINEL pick a model.",
  candidates: [
    { alias: "fast", efforts: ["low", "medium"], onPrem: true, description: "DESCRIPTION-SENTINEL" },
    { alias: "gpt-5.5", efforts: ["high"], onPrem: false },
  ],
  default: { alias: "fast", effort: "medium" },
};

function home(url: string) {
  const dir = tempDir();
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, KEY);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: url, model: "fake-1.0", keyFile, onPrem: true } }, default: "fake" }));
  mkdirSync(join(dir, "policies"));
  writeFileSync(join(dir, "policies", "test.chat.json"), JSON.stringify(POLICY));
  return dir;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const systemOneBody = (state: string, questionId = question.questionId) => ({
  model: "fake", state,
  questions: { decision: { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(question.options.map(o => [o.id, o.description ?? null])) } },
  adec: { questionId },
});

test("AC7: /v1/systemone answers the System One shape plus adec fields; /v1/route pins per turn; health", async () => {
  // The server forwards plain System One requests (no adec field) to the provider; route questions use ids p1..pN.
  const fake = fakeServer((body, path) => path === "/v1/systemone" && body.adec === undefined
    ? systemOneAnswer("p1" in body.questions.decision.criteria ? { p1: 0.1, p2: 0.1, p3: 0.8 } : { implement: 0.8, review: 0.15, plan: 0.05 })
    : new Response("no", { status: 500 }));
  const s = await serve({ home: home(fake.url), port: 0 });
  try {
    const r: any = await (await post(`${s.url}/v1/systemone`, systemOneBody("fix the bug"))).json();
    expect(r.model).toBe("fake-1.0");
    expect(r.answers.decision).toMatchObject({ type: "choice", choice: "implement" });
    expect(r.answers.decision.confidence).toBeCloseTo(0.65);
    expect(r.adec).toMatchObject({ questionId: question.questionId, abstain: false, reason: "ok" });
    const req = { policyId: "test.chat", turnId: "t1", evidence: "x", constraints: { contextTokens: 10 } };
    expect(await (await post(`${s.url}/v1/route`, req)).json()).toMatchObject({ alias: "gpt-5.5", effort: "high", pinned: false });
    expect(await (await post(`${s.url}/v1/route`, req)).json()).toMatchObject({ alias: "gpt-5.5", effort: "high", pinned: true });
    expect(fake.seen).toHaveLength(2);
    expect(await (await fetch(`${s.url}/v1/health`)).json()).toMatchObject({ ok: true });
  } finally { s.stop(); fake.stop(); }
});

test("AC7: loopback only; Origin, foreign Host, non-JSON, oversized bodies and wrong methods are refused", async () => {
  await expect(serve({ home: tempDir(), port: 0, host: "0.0.0.0" })).rejects.toThrow(UsageError);
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  const s = await serve({ home: home(fake.url), port: 0 });
  try {
    const status = async (res: Promise<Response>) => (await res).status;
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x"), { origin: "https://evil.example" }))).toBe(403);
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x"), { host: "evil.example" }))).toBe(403);
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x"), { "content-type": "text/plain" }))).toBe(415);
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x"), { "content-type": "application/jsonfoo" }))).toBe(415);
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x".repeat(70_000))))).toBe(413);
    expect(await status(post(`${s.url}/v1/systemone`, "{not json"))).toBe(400);
    expect(await status(fetch(`${s.url}/v1/route`))).toBe(405);
    expect(await status(fetch(`${s.url}/v1/nope`))).toBe(404);
    expect(await status(post(`${s.url}/v1/route`, { policyId: "missing", evidence: "", constraints: { contextTokens: 0 } }))).toBe(404);
    expect(await status(post(`${s.url}/v1/route`, { policyId: "test.chat", evidence: "", constraints: {} }))).toBe(400);
    expect(fake.seen).toHaveLength(0);
    expect(await status(post(`${s.url}/v1/systemone`, systemOneBody("x"), { "content-type": "application/json; charset=utf-8" }))).toBe(200);
  } finally { s.stop(); fake.stop(); }
});

test("AC8: no key, state, evidence, instructions or option description in responses, errors or shadow records", async () => {
  const fake = fakeServer(() => new Response(`denied ${KEY}`, { status: 401 }));
  const dir = home(fake.url);
  const s = await serve({ home: dir, port: 0 });
  try {
    const texts: string[] = [];
    const add = async (res: Promise<Response>) => texts.push(await (await res).text());
    await add(post(`${s.url}/v1/systemone`, systemOneBody("STATE-SENTINEL")));
    await add(post(`${s.url}/v1/systemone`, systemOneBody("STATE-SENTINEL", "Bad Id")));
    await add(post(`${s.url}/v1/route`, { policyId: "test.chat", turnId: "TURN-SENTINEL", evidence: "EVIDENCE-SENTINEL", constraints: { contextTokens: 1 } }));
    await add(post(`${s.url}/v1/route`, { policyId: "test.chat", evidence: "EVIDENCE-SENTINEL", constraints: { contextTokens: "EVIDENCE-SENTINEL" } }));
    expect(fake.seen.length).toBeGreaterThan(0);
    const shadow = join(dir, "shadow");
    texts.push(...readdirSync(shadow).map(f => readFileSync(join(shadow, f), "utf8")));
    for (const t of texts) for (const secret of [KEY, "STATE-SENTINEL", "EVIDENCE-SENTINEL", "TURN-SENTINEL", "INSTRUCTIONS-SENTINEL", "DESCRIPTION-SENTINEL"]) expect(t).not.toContain(secret);
    expect(texts[0]).toContain("HTTP 401");
  } finally { s.stop(); fake.stop(); }
});

test("reload keeps the previous set when a file is bad and picks up a new policy when it is good", async () => {
  const fake = fakeServer(() => systemOneAnswer({ p1: 0.9, p2: 0.05, p3: 0.05 }));
  const dir = home(fake.url), logs: string[] = [];
  const s = await serve({ home: dir, port: 0, log: l => logs.push(l) });
  try {
    const req = { policyId: "other", evidence: "x", constraints: { contextTokens: 1 } };
    expect((await post(`${s.url}/v1/route`, req)).status).toBe(404);
    writeFileSync(join(dir, "policies", "other.json"), "{broken");
    expect(await s.reload()).toBe(false);
    expect((await post(`${s.url}/v1/route`, { ...req, policyId: "test.chat" })).status).toBe(200);
    writeFileSync(join(dir, "policies", "other.json"), JSON.stringify({ ...POLICY, policyId: "other" }));
    expect(await s.reload()).toBe(true);
    expect((await post(`${s.url}/v1/route`, req)).status).toBe(200);
    expect(logs.join("\n")).toContain("reload refused");
  } finally { s.stop(); fake.stop(); }
});

test("adec serve: signal handlers are in place when the listening line appears", async () => {
  const dir = home("http://127.0.0.1:9");
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "adec.js"), "serve", "--port", "0"], { env: { ...process.env, ADEC_HOME: dir }, stdout: "pipe", stderr: "pipe" });
    await proc.stdout.getReader().read();
    proc.kill(sig);
    expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => { proc.kill("SIGKILL"); return "hung"; })])).toBe(0);
  }
});
