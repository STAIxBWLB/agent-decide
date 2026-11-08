import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../src/config.ts";
import type { Question } from "../src/contract.ts";

export interface Seen { path: string; auth: string | null; body: any }
export interface Fake { url: string; seen: Seen[]; stop: () => void }

/** A loopback fake server; `respond` builds the response from the parsed request body. */
export function fakeServer(respond: (body: any, path: string) => Response | Promise<Response>): Fake {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json().catch(() => null);
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization"), body });
      return respond(body, path);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

export const question: Question = {
  questionId: "test.triage.v1",
  instructions: "Pick the task class.",
  options: [{ id: "implement", description: "write code" }, { id: "review", description: "review a change" }, { id: "plan" }],
};

export function provider(url: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: "fake", kind: "systemone", endpoint: url, model: "fake-1.0", onPrem: true, timeoutMs: 2000, maxStateChars: 8000, ...extra };
}

export function systemOneAnswer(probabilities: Record<string, number>, choice?: string) {
  const top = choice ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return Response.json({ model: "fake-1.0", answers: { decision: { type: "choice", choice: top, probabilities, confidence: 0.5 } } });
}

export function logitsAnswer(top: { token: string; logprob: number }[]) {
  return Response.json({ model: "fake-lm", choices: [{ message: { content: top[0]?.token ?? "" }, logprobs: { content: [{ token: top[0]?.token ?? "", logprob: top[0]?.logprob ?? 0, top_logprobs: top }] } }] });
}

export function tempDir(): string { return mkdtempSync(join(tmpdir(), "adec-test-")); }
