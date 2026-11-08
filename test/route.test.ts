import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, main } from "../src/cli.ts";
import { UsageError } from "../src/contract.ts";
import { parsePolicy } from "../src/policy.ts";
import { PinStore, route, type RouteRequest } from "../src/route.ts";
import { labelOutcome, routeReport } from "../src/shadow.ts";
import { fakeServer, provider, tempDir } from "./fakes.ts";

const POLICY = {
  policyId: "test.chat", provider: "fake", instructions: "Pick the cheapest model and effort that can finish this turn well.",
  candidates: [
    { alias: "fast", efforts: ["low", "medium"], onPrem: true, description: "small local model", costEstimate: 0 },
    { alias: "gpt-5.5", efforts: ["medium", "high"], onPrem: false, ctxMax: 200_000, costEstimate: 1 },
  ],
  default: { alias: "fast", effort: "medium" }, contextLimit: 20_000, minMargin: 0.2,
};
const policy = parsePolicy(POLICY);
const base: RouteRequest = { policyId: "test.chat", evidence: "summary of the turn", constraints: { contextTokens: 1000 } };
const noKey = { key: async () => undefined };

/** A fake decider that puts `top` of the probability on option `pick` (1-based) among whatever options it is asked. */
function decider(pick: number | ((n: number) => number), top = 0.9) {
  return fakeServer(body => {
    const opts = Object.keys(body.questions.decision.criteria);
    const at = typeof pick === "number" ? pick : pick(opts.length);
    const rest = (1 - top) / (opts.length - 1);
    const probabilities = Object.fromEntries(opts.map((id, i) => [id, i === at - 1 ? top : rest]));
    return Response.json({ answers: { decision: { type: "choice", choice: opts[at - 1], probabilities } } });
  });
}
const optionsSent = (body: any) => Object.values(body.questions.decision.criteria as Record<string, string>);

test("AC1: a PII turn with an off-prem decider builds no question and answers an on-prem alias", async () => {
  const fake = decider(4);
  try {
    for (const flag of ["pii", "private"] as const) {
      const r = await route({ ...base, constraints: { contextTokens: 1000, [flag]: true } }, policy, provider(fake.url, { onPrem: false }), { shadowDir: null, ...noKey });
      expect(r).toMatchObject({ alias: "fast", effort: "medium", reason: "off_prem", fallbackApplied: true, decider: null, rules: ["onprem_only"] });
    }
    expect(fake.seen).toHaveLength(0);
  } finally { fake.stop(); }
});

test("AC1: with an on-prem decider, off-prem candidates are not even offered; an explicit off-prem pick is no_candidate", async () => {
  const fake = decider(2);
  try {
    const p = provider(fake.url);
    const r = await route({ ...base, constraints: { contextTokens: 1000, pii: true } }, policy, p, { shadowDir: null, ...noKey });
    expect(r).toMatchObject({ alias: "fast", effort: "medium", reason: "ok" });
    expect(optionsSent(fake.seen[0]!.body).every(d => d.includes("model fast"))).toBe(true);
    const explicit = await route({ ...base, constraints: { contextTokens: 1000, pii: true, explicit: { alias: "gpt-5.5", effort: "high" } } }, policy, p, { shadowDir: null, ...noKey });
    expect(explicit).toMatchObject({ alias: null, effort: null, reason: "no_candidate", abstain: true, rules: ["onprem_only", "no_candidate"] });
    expect(fake.seen).toHaveLength(1);
  } finally { fake.stop(); }
});

test("AC2: explicit wins without a question; an explicit pair outside the policy is a usage error", async () => {
  const fake = decider(1);
  try {
    const p = provider(fake.url);
    const r = await route({ ...base, constraints: { contextTokens: 900_000, explicit: { alias: "gpt-5.5", effort: "high" } } }, policy, p, { shadowDir: null, ...noKey });
    expect(r).toMatchObject({ alias: "gpt-5.5", effort: "high", reason: "explicit", abstain: false, decider: null, estimatedCost: 1, rules: ["explicit"] });
    await expect(route({ ...base, constraints: { contextTokens: 1, explicit: { alias: "gpt-5.5", effort: "low" } } }, policy, p, { shadowDir: null, ...noKey })).rejects.toThrow(UsageError);
    await expect(route({ ...base, candidates: ["fast"], constraints: { contextTokens: 1, explicit: { alias: "gpt-5.5", effort: "high" } } }, policy, p, { shadowDir: null, ...noKey })).rejects.toThrow(UsageError);
    expect(fake.seen).toHaveLength(0);
  } finally { fake.stop(); }
});

test("AC2: no downgrade above the context limit, ctx_max, no_candidate and single, each recorded", async () => {
  const fake = decider(1);
  try {
    const p = provider(fake.url), o = { shadowDir: null, ...noKey };
    const current = { alias: "gpt-5.5", effort: "medium" };
    const up = await route({ ...base, constraints: { contextTokens: 30_000, current } }, policy, p, o);
    expect(up).toMatchObject({ alias: "gpt-5.5", effort: "medium", reason: "ok", rules: ["no_downgrade"] });
    expect(optionsSent(fake.seen[0]!.body)).toHaveLength(2);
    // Below the limit the cheaper candidates stay.
    await route({ ...base, constraints: { contextTokens: 10_000, current } }, policy, p, o);
    expect(optionsSent(fake.seen[1]!.body)).toHaveLength(4);
    const none = await route({ ...base, constraints: { contextTokens: 250_000, current } }, policy, p, o);
    expect(none).toMatchObject({ alias: null, reason: "no_candidate", rules: ["no_downgrade", "ctx_max", "no_candidate"] });
    const small = await route({ ...base, constraints: { contextTokens: 250_000 } }, policy, p, o);
    expect(small.rules).toEqual(["ctx_max"]);
    const single = parsePolicy({ ...POLICY, candidates: [{ ...POLICY.candidates[0]!, efforts: ["low"] }, POLICY.candidates[1]!], default: { alias: "fast", effort: "low" } });
    const one = await route({ ...base, constraints: { contextTokens: 1, pii: true } }, single, p, o);
    expect(one).toMatchObject({ alias: "fast", effort: "low", reason: "single", decider: null, rules: ["onprem_only", "single"] });
    expect(fake.seen).toHaveLength(3);
  } finally { fake.stop(); }
});

test("AC3: a request narrows but never widens; the decider's pick maps back to the pair", async () => {
  const fake = decider(n => n);
  try {
    const p = provider(fake.url), o = { shadowDir: null, ...noKey };
    expect(await route(base, policy, p, o)).toMatchObject({ alias: "gpt-5.5", effort: "high", reason: "ok", fallbackApplied: false, estimatedCost: 1 });
    expect(await route({ ...base, candidates: ["fast"] }, policy, p, o)).toMatchObject({ alias: "fast", effort: "medium" });
    await expect(route({ ...base, candidates: ["claude-opus"] }, policy, p, o)).rejects.toThrow(UsageError);
  } finally { fake.stop(); }
});

test("AC3: timeout, malformed and low-margin answers apply the fallback", async () => {
  const slow = fakeServer(async () => { await Bun.sleep(400); return Response.json({}); });
  const bad = fakeServer(() => Response.json({ answers: {} }));
  const flat = decider(4, 0.3);
  try {
    const o = { shadowDir: null, ...noKey };
    expect(await route(base, policy, provider(slow.url, { timeoutMs: 100 }), o)).toMatchObject({ alias: "fast", effort: "medium", reason: "timeout", fallbackApplied: true, abstain: true });
    expect(await route(base, policy, provider(bad.url), o)).toMatchObject({ alias: "fast", effort: "medium", reason: "malformed", fallbackApplied: true });
    expect(await route(base, policy, provider(flat.url), o)).toMatchObject({ alias: "fast", effort: "medium", reason: "low_margin", fallbackApplied: true });
    // The default was removed by a rule: the first surviving pair is the fallback.
    expect(await route({ ...base, constraints: { contextTokens: 30_000, current: { alias: "gpt-5.5", effort: "high" } } }, policy, provider(flat.url), o))
      .toMatchObject({ alias: "gpt-5.5", effort: "medium", fallbackApplied: true });
  } finally { slow.stop(); bad.stop(); flat.stop(); }
});

test("AC4: a pin is reused within the TTL, re-decided after it or when a rule breaks it, and never written", async () => {
  const fake = decider(n => n);
  try {
    let now = 0;
    const pins = new PinStore(30 * 60_000, 10_000, () => now);
    const home = tempDir(), shadow = join(home, "shadow");
    const p = provider(fake.url), o = { shadowDir: shadow, pins, ...noKey };
    const turn = { ...base, turnId: "turn-SECRET-42" };
    expect(await route(turn, policy, p, o)).toMatchObject({ alias: "gpt-5.5", effort: "high", pinned: false });
    now += 10 * 60_000;
    expect(await route(turn, policy, p, o)).toMatchObject({ alias: "gpt-5.5", effort: "high", pinned: true, reason: "pinned", rules: ["pinned"] });
    expect(fake.seen).toHaveLength(1);
    // A PII turn removes the off-prem pin: decided again among on-prem pairs.
    const broken = await route({ ...turn, constraints: { contextTokens: 1000, pii: true } }, policy, p, o);
    expect(broken).toMatchObject({ alias: "fast", effort: "medium", pinned: false, rules: ["onprem_only", "pin_broken"] });
    now += 31 * 60_000;
    expect((await route(turn, policy, p, o)).pinned).toBe(false);
    expect(fake.seen).toHaveLength(3);
    expect(readdirSync(home)).toEqual(["shadow"]);
    expect(readdirSync(shadow).map(f => readFileSync(join(shadow, f), "utf8")).join("")).not.toContain("SECRET");
    // Without a pin store (CLI, MCP, library) every call decides.
    await route(turn, policy, p, { shadowDir: null, ...noKey });
    expect(fake.seen).toHaveLength(4);
  } finally { fake.stop(); }
});

test("route records take route outcome words and feed the per-policy report", async () => {
  const fake = decider(1);
  try {
    const shadow = join(tempDir(), "shadow");
    const r = await route(base, policy, provider(fake.url), { shadowDir: shadow, ...noKey });
    await expect(labelOutcome(shadow, r.id, "accepted")).rejects.toThrow(UsageError);
    await labelOutcome(shadow, r.id, "completed");
    expect(await routeReport(shadow)).toEqual([{ policyId: "test.chat", routes: 1, byReason: { ok: 1 }, fallbackApplied: 0, pinned: 0, labelled: 1, outcomes: { completed: 1 } }]);
  } finally { fake.stop(); }
});

test("policy validation: pairs cap, default among pairs, unique aliases, provider configured", () => {
  const many = { ...POLICY, candidates: [{ alias: "a", efforts: Array.from({ length: 14 }, (_, i) => `e${i}`), onPrem: true }, { alias: "b", efforts: Array.from({ length: 13 }, (_, i) => `e${i}`), onPrem: true }], default: { alias: "a", effort: "e0" } };
  for (const bad of [many, { ...POLICY, default: { alias: "fast", effort: "high" } }, { ...POLICY, candidates: [POLICY.candidates[0], POLICY.candidates[0]] },
    { ...POLICY, policyId: "x".repeat(51) }, { ...POLICY, candidates: [{ ...POLICY.candidates[0], onPrem: "yes" }] }, { ...POLICY, extra: 1 }])
    expect(() => parsePolicy(bad)).toThrow(UsageError);
  expect(() => parsePolicy(POLICY, { providers: {} })).toThrow(UsageError);
});

test("CLI route: exit 0 with a pick, 3 with no candidate, never pins", async () => {
  const fake = decider(1);
  try {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { fake: { kind: "systemone", endpoint: fake.url, model: "fake-1.0", onPrem: true } } }));
    mkdirSync(join(home, "policies"));
    writeFileSync(join(home, "policies", "test.chat.json"), JSON.stringify(POLICY));
    const file = join(home, "req.json");
    const out: string[] = [], io = { out: (s: string) => out.push(s), err: () => {}, env: { ADEC_HOME: home } };
    writeFileSync(file, JSON.stringify({ ...base, turnId: "t1" }));
    expect(await main(["route", "--request", file, "--json"], io)).toBe(EXIT.ok);
    expect(await main(["route", "--request", file, "--json"], io)).toBe(EXIT.ok);
    expect(JSON.parse(out.at(-1)!).pinned).toBe(false);
    expect(fake.seen).toHaveLength(2);
    writeFileSync(file, JSON.stringify({ ...base, constraints: { contextTokens: 250_000, current: { alias: "gpt-5.5", effort: "high" } } }));
    expect(await main(["route", "--request", file], io)).toBe(EXIT.abstained);
  } finally { fake.stop(); }
});
