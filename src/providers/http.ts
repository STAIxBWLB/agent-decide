import type { ProviderConfig } from "../config.ts";
import type { Reason } from "../contract.ts";
import { readBodyBounded } from "../io.ts";

export const RESPONSE_BYTES = 1024 * 1024;

/** A provider failure; the message names the provider, the cause class and the HTTP status only (never the key or bodies). */
export class ProviderError extends Error {
  constructor(public reason: Exclude<Reason, "ok" | "low_margin" | "off_prem" | "state_too_long">, provider: string, detail: string) {
    super(`provider ${provider}: ${detail}`);
  }
}

export async function postJson(provider: ProviderConfig, path: string, body: unknown, key: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    // redirect "error": a redirect must never carry the key to another origin.
    res = await fetch(`${provider.endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(provider.timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new ProviderError("timeout", provider.name, `no answer within ${provider.timeoutMs} ms; raise timeoutMs or check the server`);
    throw new ProviderError("http", provider.name, "request failed before a response (unreachable, TLS or redirect); check the endpoint with adec providers");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError("http", provider.name, `HTTP ${res.status}; check the endpoint, model name and key file`);
  }
  const text = await readBodyBounded(res, RESPONSE_BYTES).catch(() => undefined);
  if (text === undefined) throw new ProviderError("malformed", provider.name, `response body missing or larger than ${RESPONSE_BYTES} bytes`);
  try { return JSON.parse(text); } catch { throw new ProviderError("malformed", provider.name, "response is not JSON"); }
}

export function object(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}
