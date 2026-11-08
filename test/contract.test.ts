import { expect, test } from "bun:test";
import { parseMinMargin, parseQuestion, topTwo, UsageError } from "../src/contract.ts";
import { decide } from "../src/decide.ts";
import { fakeServer, provider, question } from "./fakes.ts";

const base = { questionId: "a.b", instructions: "x", options: [{ id: "a" }, { id: "b" }] };

test("AC1: valid question parses", () => {
  expect(parseQuestion(base).options).toEqual([{ id: "a" }, { id: "b" }]);
});

test("AC1: bad ids, duplicates, option counts and unknown fields are refused", () => {
  const bad = [
    { ...base, questionId: "A b" },
    { ...base, options: [{ id: "a" }, { id: "a" }] },
    { ...base, options: [{ id: "a" }] },
    { ...base, options: Array.from({ length: 27 }, (_, i) => ({ id: `o${i}` })) },
    { ...base, options: [{ id: "Bad" }, { id: "b" }] },
    { ...base, options: [{ id: "a", description: "two\nlines" }, { id: "b" }] },
    { ...base, instructions: "" },
    { ...base, extra: 1 },
  ];
  for (const q of bad) expect(() => parseQuestion(q)).toThrow(UsageError);
  expect(parseQuestion({ ...base, options: Array.from({ length: 26 }, (_, i) => ({ id: `o${i}` })) }).options).toHaveLength(26);
});

test("AC1: min margin bounds", () => {
  expect(parseMinMargin(undefined)).toBe(0);
  expect(parseMinMargin("0.2")).toBe(0.2);
  for (const v of ["-0.1", "1.5", "x"]) expect(() => parseMinMargin(v)).toThrow(UsageError);
});

test("AC1: over-long state abstains with state_too_long and never calls the provider", async () => {
  const fake = fakeServer(() => Response.json({}));
  try {
    const d = await decide({ question, state: "x".repeat(11) }, provider(fake.url, { maxStateChars: 10 }), { shadowDir: null, key: async () => undefined });
    expect(d.reason).toBe("state_too_long");
    expect(d.abstain).toBe(true);
    expect(fake.seen).toHaveLength(0);
  } finally { fake.stop(); }
});

test("margin is top-1 minus top-2 and ties choose the first option", () => {
  expect(topTwo(question, { implement: 0.6, review: 0.3, plan: 0.1 })).toEqual({ choice: "implement", margin: 0.6 - 0.3 });
  expect(topTwo(question, { implement: 0.4, review: 0.4, plan: 0.2 })).toEqual({ choice: "implement", margin: 0 });
});
