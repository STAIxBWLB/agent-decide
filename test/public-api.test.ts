import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/index.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

const policy: api.Policy = {
  policyId: "p", provider: "fake", instructions: "Pick.", contextLimit: 20_000, minMargin: 0,
  candidates: [{ alias: "fast", efforts: ["low"], onPrem: true }, { alias: "big", efforts: ["high"], onPrem: true }], default: { alias: "fast", effort: "low" },
};
const routeRequest: api.RouteRequest = { policyId: "p", evidence: "e", constraints: { contextTokens: 1 } };

// Every exported entry point must refuse invalid input with UsageError before any network call (AGENTS.md).
test("public entry points validate their inputs like the CLI, before any request", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  const key = { key: async () => undefined };
  const good = provider(fake.url);
  const badProviders = [
    { ...good, model: "latest" },
    { ...good, model: "jev-latest" },
    { ...good, onPrem: false, endpoint: "http://203.0.113.5:8000" },
    { ...good, kind: "other" as never },
    { ...good, apiKey: "x" } as never,
  ];
  const cases: [string, () => Promise<unknown>][] = [
    ...badProviders.map((p, i) => [`decide provider ${i}`, () => api.decide({ question, state: "s" }, p, { shadowDir: null, ...key })] as [string, () => Promise<unknown>]),
    ...badProviders.map((p, i) => [`evaluate provider ${i}`, () => api.evaluate(question, [{ state: "s", label: "plan" }], p, key)] as [string, () => Promise<unknown>]),
    ["decide question", () => api.decide({ question: { ...question, options: [] }, state: "s" }, good, { shadowDir: null, ...key })],
    ["decide request", () => api.decide({ question, state: "s", minMargin: -1 }, good, { shadowDir: null, ...key })],
    ["evaluate row", () => api.evaluate(question, [{ state: "s", label: "nope" }], good, key)],
    ["labelOutcome id", () => api.labelOutcome(tempDir(), "x", "accepted")],
    ["selectProvider name", async () => api.selectProvider({ providers: {} }, "constructor")],
    ["parseProvider", async () => api.parseProvider("p", { kind: "logits" })],
    ["parseQuestion", async () => api.parseQuestion({})],
    ["decide options missing shadowDir", () => api.decide({ question, state: "s" }, good, {} as never)],
    ["decide options unknown", () => api.decide({ question, state: "s" }, good, { shadowDir: null, extra: 1 } as never)],
    ["evaluate options unknown", () => api.evaluate(question, [{ state: "s", label: "plan" }], good, { shadowDir: "/tmp" } as never)],
    ["shadowReport unreadable", async () => { const f = join(tempDir(), "file"); writeFileSync(f, "x"); return api.shadowReport(f); }],
    ["parseRows question", async () => api.parseRows("", { ...question, options: [] })],
    ["selectProvider config", async () => api.selectProvider({ providers: { p: { ...good, model: "latest" } } }, "p")],
    ["selectProvider http", async () => api.selectProvider({ providers: { p: { ...good, onPrem: false, endpoint: "http://203.0.113.5" } } }, "p")],
    ["decide options fits", () => api.decide({ question, state: "s" }, good, { shadowDir: null, fits: [{ v: 1 }] as never, ...key })],
    ["calibrate row", () => api.calibrate(question, [{ state: "s", label: "nope" }], good, key)],
    ["calibrate target", () => api.calibrate(question, [{ state: "s", label: "plan" }], good, { ...key, targetAccuracy: 2 })],
    ["calibrate options", () => api.calibrate(question, [{ state: "s", label: "plan" }], good, { ...key, extra: 1 } as never)],
    ["calibrate provider", () => api.calibrate(question, [{ state: "s", label: "plan" }], badProviders[0]!, key)],
    ["loadFits home", () => api.loadFits("")],
    ["parsePolicy", async () => api.parsePolicy({ ...policy, default: { alias: "fast", effort: "max" } })],
    ["parseRouteRequest", async () => api.parseRouteRequest({ ...routeRequest, turnId: "has space" })],
    ["route request", () => api.route({ ...routeRequest, constraints: { contextTokens: -1 } }, policy, good, { shadowDir: null, ...key })],
    ["route policy", () => api.route(routeRequest, { ...policy, candidates: [] }, good, { shadowDir: null, ...key })],
    ["route provider", () => api.route(routeRequest, policy, badProviders[0]!, { shadowDir: null, ...key })],
    ["route provider name", () => api.route(routeRequest, policy, { ...good, name: "other" }, { shadowDir: null, ...key })],
    ["route options pins", () => api.route(routeRequest, policy, good, { shadowDir: null, pins: {} } as never)],
    ["route widen", () => api.route({ ...routeRequest, candidates: ["other"] }, policy, good, { shadowDir: null, ...key })],
    ["serve host", () => api.serve({ home: tempDir(), host: "0.0.0.0", port: 0 })],
    ["serve options", () => api.serve({ home: tempDir(), port: 0, extra: 1 } as never)],
    ["labelOutcome label", () => api.labelOutcome(tempDir(), "a".repeat(32), 5 as never)],
  ];
  try {
    for (const [name, run] of cases) {
      const outcome = await run().then(() => "resolved", e => (e instanceof api.UsageError ? "usage" : `other: ${e}`));
      expect(`${name}: ${outcome}`).toBe(`${name}: usage`);
    }
    expect(fake.seen).toHaveLength(0);
  } finally { fake.stop(); }
});

test("only entry points are public; internal helpers are not exported", () => {
  for (const internal of ["topTwo", "ece", "macroF1", "readKey", "appendDecision", "readRecords", "askSystemOne", "askLogits", "temper", "fitTemperature", "fitThreshold", "appendFit", "PinStore", "appendRoute", "serveMcp"]) expect(internal in api).toBe(false);
});
