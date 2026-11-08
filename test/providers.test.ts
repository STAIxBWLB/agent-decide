import { expect, test } from "bun:test";
import { UsageError } from "../src/contract.ts";
import { decide } from "../src/decide.ts";
import { EVIDENCE_SENTENCE } from "../src/providers/systemone.ts";
import { fakeServer, logitsAnswer, provider, question, systemOneAnswer } from "./fakes.ts";

const noKey = { shadowDir: null, key: async () => undefined } as const;

test("AC2: System One request shape and a valid answer", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.1 }));
  try {
    const d = await decide({ question, state: "fix the parser" }, provider(fake.url), { shadowDir: null, key: async () => "k-123" });
    expect(d).toMatchObject({ choice: "implement", abstain: false, reason: "ok" });
    expect(d.margin).toBeCloseTo(0.5);
    const req = fake.seen[0]!;
    expect(req.path).toBe("/v1/systemone");
    expect(req.auth).toBe("Bearer k-123");
    expect(req.body).toEqual({
      model: "fake-1.0", state: "fix the parser",
      questions: { decision: { type: "choice", instructions: `Pick the task class.\n${EVIDENCE_SENTENCE}`, criteria: { implement: "write code", review: "review a change", plan: null } } },
    });
  } finally { fake.stop(); }
});

test("AC2: mismatched keys, bad sums, out-of-range values and outside choices are refused", async () => {
  const cases: [() => Response, string][] = [
    [() => systemOneAnswer({ implement: 0.7, review: 0.3 }), "outside_options"],
    [() => systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.2 }), "malformed"],
    [() => systemOneAnswer({ implement: 1.2, review: -0.1, plan: -0.1 }), "malformed"],
    [() => systemOneAnswer({ implement: 0.7, review: 0.2, plan: 0.1 }, "other"), "outside_options"],
    [() => Response.json({ answers: { decision: { type: "score", value: 1 } } }), "malformed"],
    [() => new Response("not json"), "malformed"],
  ];
  for (const [res, reason] of cases) {
    const fake = fakeServer(res);
    try {
      const d = await decide({ question, state: "s" }, provider(fake.url), noKey);
      expect(d.reason).toBe(reason as never);
      expect(d.abstain).toBe(true);
      expect(d.choice).toBeNull();
    } finally { fake.stop(); }
  }
});

test("AC3: logits adapter maps labels, merges spacing variants, renormalizes and reports label mass", async () => {
  const fake = fakeServer(() => logitsAnswer([
    { token: "A", logprob: Math.log(0.5) }, { token: " A", logprob: Math.log(0.1) },
    { token: "B", logprob: Math.log(0.2) }, { token: "The", logprob: Math.log(0.15) },
  ]));
  try {
    const d = await decide({ question, state: "s" }, provider(fake.url, { kind: "logits" }), noKey);
    expect(d.choice).toBe("implement");
    expect(d.probabilities.implement).toBeCloseTo(0.75);
    expect(d.probabilities.review).toBeCloseTo(0.25);
    expect(d.probabilities.plan).toBe(0);
    expect(d.labelMass).toBeCloseTo(0.8);
    const req = fake.seen[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.body).toMatchObject({ model: "fake-1.0", max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 });
    expect(req.body.messages[0].content).toContain("A: implement - write code");
    expect(req.body.messages[1].content).toBe('State (JSON string): "s"');
  } finally { fake.stop(); }
});

test("AC3: no label among the top tokens is malformed", async () => {
  const fake = fakeServer(() => logitsAnswer([{ token: "The", logprob: -0.1 }]));
  try {
    const d = await decide({ question, state: "s" }, provider(fake.url, { kind: "logits" }), noKey);
    expect(d).toMatchObject({ abstain: true, reason: "malformed", choice: null });
  } finally { fake.stop(); }
});

test("AC4: low margin, timeout and HTTP errors abstain with a null choice", async () => {
  const close = fakeServer(() => systemOneAnswer({ implement: 0.4, review: 0.35, plan: 0.25 }));
  const slow = fakeServer(async () => { await Bun.sleep(400); return systemOneAnswer({ implement: 1, review: 0, plan: 0 }); });
  const down = fakeServer(() => new Response("no", { status: 503 }));
  try {
    expect(await decide({ question, state: "s", minMargin: 0.1 }, provider(close.url), noKey)).toMatchObject({ abstain: true, reason: "low_margin", choice: null });
    expect(await decide({ question, state: "s", minMargin: 0.01 }, provider(close.url), noKey)).toMatchObject({ abstain: false, choice: "implement" });
    expect(await decide({ question, state: "s" }, provider(slow.url, { timeoutMs: 100 }), noKey)).toMatchObject({ abstain: true, reason: "timeout", choice: null });
    const d = await decide({ question, state: "s" }, provider(down.url), noKey);
    expect(d).toMatchObject({ abstain: true, reason: "http", choice: null });
    expect(d.error).toContain("HTTP 503");
  } finally { close.stop(); slow.stop(); down.stop(); }
});

test("AC5: PII never reaches an off-prem provider, and the key is not even read", async () => {
  const fake = fakeServer(() => systemOneAnswer({ implement: 1, review: 0, plan: 0 }));
  let keyReads = 0;
  try {
    const off = provider(fake.url, { onPrem: false });
    const d = await decide({ question, state: "student 2026123", pii: true }, off, { shadowDir: null, key: async () => { keyReads++; return "k"; } });
    expect(d).toMatchObject({ abstain: true, reason: "off_prem", choice: null });
    expect(fake.seen).toHaveLength(0);
    expect(keyReads).toBe(0);
    const on = await decide({ question, state: "student 2026123", pii: true }, provider(fake.url), noKey);
    expect(on.choice).toBe("implement");
    expect(fake.seen).toHaveLength(1);
  } finally { fake.stop(); }
});

test("redirects are refused so a key never follows them", async () => {
  const fake = fakeServer(() => new Response(null, { status: 307, headers: { location: "http://127.0.0.1:9/elsewhere" } }));
  try {
    const d = await decide({ question, state: "s" }, provider(fake.url), { shadowDir: null, key: async () => "k" });
    expect(d).toMatchObject({ abstain: true, reason: "http" });
  } finally { fake.stop(); }
});

test("review F1: a server-supplied model string is never reported (it could reflect the key or state)", async () => {
  const fake = fakeServer((body, path) => path === "/v1/systemone"
    ? Response.json({ model: `echo ${body.state} KEY-XYZ`, answers: { decision: { type: "choice", choice: "implement", probabilities: { implement: 1, review: 0, plan: 0 } } } })
    : Response.json({ model: `echo ${body.messages[1].content}`, choices: [{ logprobs: { content: [{ token: "A", logprob: 0, top_logprobs: [{ token: "A", logprob: 0 }] }] } }] }));
  try {
    for (const kind of ["systemone", "logits"] as const) {
      const d = await decide({ question, state: "SECRET-STATE" }, provider(fake.url, { kind }), { shadowDir: null, key: async () => "KEY-XYZ" });
      expect(d.decider.model).toBe("fake-1.0");
      expect(JSON.stringify(d)).not.toContain("SECRET-STATE");
      expect(JSON.stringify(d)).not.toContain("KEY-XYZ");
    }
  } finally { fake.stop(); }
});

test("review F2: positive logprobs are ignored and a non-distribution never becomes a decision", async () => {
  const fake = fakeServer(() => logitsAnswer([{ token: "A", logprob: 1000 }, { token: "B", logprob: Math.log(0.5) }]));
  try {
    const d = await decide({ question, state: "s" }, provider(fake.url, { kind: "logits" }), noKey);
    expect(d.choice).toBe("review");
    expect(Object.values(d.probabilities).every(Number.isFinite)).toBe(true);
  } finally { fake.stop(); }
  const bad = fakeServer(() => logitsAnswer([{ token: "A", logprob: 1000 }]));
  try {
    expect(await decide({ question, state: "s" }, provider(bad.url, { kind: "logits" }), noKey)).toMatchObject({ abstain: true, reason: "malformed", choice: null });
  } finally { bad.stop(); }
});

test("review F3: a body that stalls after the headers is a timeout, not malformed", async () => {
  const fake = fakeServer(() => new Response(new ReadableStream({
    async start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); await Bun.sleep(500); controller.close(); },
  }), { headers: { "content-type": "application/json" } }));
  try {
    expect(await decide({ question, state: "s" }, provider(fake.url, { timeoutMs: 150 }), noKey)).toMatchObject({ abstain: true, reason: "timeout", choice: null });
  } finally { fake.stop(); }
});

test("review F4: the library entry point validates the question and request like the CLI", async () => {
  const p = provider("http://127.0.0.1:9");
  const one = { ...question, options: [{ id: "implement" }] };
  const dup = { ...question, options: [{ id: "a" }, { id: "a" }] };
  await expect(decide({ question: one, state: "s" }, p, noKey)).rejects.toThrow(UsageError);
  await expect(decide({ question: dup, state: "s" }, p, noKey)).rejects.toThrow(UsageError);
  await expect(decide({ question, state: 5 as never }, p, noKey)).rejects.toThrow(UsageError);
  await expect(decide({ question, state: "s", pii: "yes" as never }, p, noKey)).rejects.toThrow(UsageError);
  await expect(decide({ question, state: "s", extra: 1 } as never, p, noKey)).rejects.toThrow(UsageError);
});
