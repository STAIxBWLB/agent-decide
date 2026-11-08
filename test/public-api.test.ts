import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../src/index.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

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
  for (const internal of ["topTwo", "ece", "macroF1", "readKey", "appendDecision", "readRecords", "askSystemOne", "askLogits"]) expect(internal in api).toBe(false);
});
