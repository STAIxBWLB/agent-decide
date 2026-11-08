import { expect, test } from "bun:test";
import { decide } from "../src/decide.ts";
import { parsePolicy } from "../src/policy.ts";
import { route } from "../src/route.ts";
import { readRecords } from "../src/shadow.ts";
import { fakeServer, provider, question, systemOneAnswer, tempDir } from "./fakes.ts";

test("AC5: configured decider version reaches decisions, routes and both shadow records; omitted otherwise", async () => {
  const fake = fakeServer(body => {
    const ids = Object.keys(body.questions.decision.criteria);
    return systemOneAnswer(Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.8 : 0.2 / (ids.length - 1)])));
  });
  try {
    const policy = parsePolicy({
      policyId: "test.version", provider: "fake", instructions: "Choose the candidate.",
      candidates: [{ alias: "small", efforts: ["low"], onPrem: true }, { alias: "large", efforts: ["high"], onPrem: true }],
      default: { alias: "small", effort: "low" }, contextLimit: 1000, minMargin: 0,
    });
    for (const version of ["2026-11-08", undefined]) {
      const p = provider(fake.url, version === undefined ? {} : { version });
      const shadowDir = tempDir(), options = { shadowDir, key: async () => undefined };
      const decision = await decide({ question, state: "synthetic" }, p, options);
      const routed = await route({ policyId: policy.policyId, evidence: "synthetic", constraints: { contextTokens: 1 } }, policy, p, options);
      expect(routed.decider).not.toBeNull();
      const records = await readRecords(shadowDir);
      expect(records.map(r => r.kind)).toEqual(["decision", "route"]);
      for (const target of [decision.decider, routed.decider!, ...records]) {
        if (version === undefined) expect(Object.hasOwn(target, "version")).toBe(false);
        else expect(target).toHaveProperty("version", version);
      }
    }
  } finally { fake.stop(); }
});
