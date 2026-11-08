import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { UsageError } from "./contract.ts";
import { readJsonBounded, readTextBounded } from "./io.ts";

export type ProviderKind = "systemone" | "logits";
export interface ProviderConfig {
  name: string;
  kind: ProviderKind;
  endpoint: string;
  model: string;
  keyFile?: string;
  onPrem: boolean;
  timeoutMs: number;
  maxStateChars: number;
}
export interface Config { providers: Record<string, ProviderConfig>; default?: string }

export const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_MAX_STATE_CHARS = 8000;
const CONFIG_BYTES = 64 * 1024, KEY_BYTES = 4096;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function adecHome(env: Record<string, string | undefined> = process.env): string {
  return env.ADEC_HOME || join(homedir(), ".adec");
}

function fail(where: string, fix: string): never {
  throw new UsageError(`configuration ${where}: ${fix}; edit config.json in ADEC_HOME`);
}

function integer(raw: unknown, fallback: number, min: number, max: number, where: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) fail(where, `give an integer from ${min} to ${max}`);
  return raw;
}

export function parseProvider(name: string, raw: unknown): ProviderConfig {
  const where = `providers.${name}`;
  if (!NAME.test(name)) fail(where, "use 1-32 characters of a-z, 0-9, '_' or '-' for the provider name");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(where, "expected an object");
  const allowed = ["kind", "endpoint", "model", "keyFile", "onPrem", "timeoutMs", "maxStateChars"];
  const p = raw as Record<string, unknown>;
  const unknown = Object.keys(p).filter(k => !allowed.includes(k));
  if (unknown.length) fail(where, `remove unknown field ${unknown.join(", ")}`);
  if (p.kind !== "systemone" && p.kind !== "logits") fail(`${where}.kind`, 'use "systemone" or "logits"');
  if (typeof p.onPrem !== "boolean") fail(`${where}.onPrem`, "set true only for a decider on your own network, false otherwise");
  if (typeof p.model !== "string" || !p.model.trim() || p.model === "latest" || p.model.endsWith("-latest"))
    fail(`${where}.model`, "pin a model name and version; moving aliases such as \"latest\" or \"*-latest\" are not accepted");
  if (typeof p.endpoint !== "string") fail(`${where}.endpoint`, "give the server base URL, for example https://decider.example");
  let url: URL;
  try { url = new URL(p.endpoint); } catch { fail(`${where}.endpoint`, "give a valid http(s) base URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`${where}.endpoint`, "use an http or https URL");
  if (url.username || url.password) fail(`${where}.endpoint`, "remove credentials from the URL and use keyFile");
  if (url.search || url.hash) fail(`${where}.endpoint`, "remove the query and fragment from the base URL");
  if (url.protocol === "http:" && !p.onPrem && !LOOPBACK.has(url.hostname))
    fail(`${where}.endpoint`, "plain http is allowed only for loopback or an onPrem provider; use https");
  if (p.keyFile !== undefined && (typeof p.keyFile !== "string" || !isAbsolute(p.keyFile))) fail(`${where}.keyFile`, "give an absolute path to a file that holds only the key");
  return {
    name,
    kind: p.kind,
    endpoint: url.href.replace(/\/+$/, ""),
    model: p.model,
    ...(p.keyFile === undefined ? {} : { keyFile: p.keyFile as string }),
    onPrem: p.onPrem,
    timeoutMs: integer(p.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 120_000, `${where}.timeoutMs`),
    maxStateChars: integer(p.maxStateChars, DEFAULT_MAX_STATE_CHARS, 1, 200_000, `${where}.maxStateChars`),
  };
}

export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("file", "expected a JSON object with \"providers\"");
  const c = raw as Record<string, unknown>;
  const unknown = Object.keys(c).filter(k => k !== "providers" && k !== "default");
  if (unknown.length) fail("file", `remove unknown field ${unknown.join(", ")}`);
  if (typeof c.providers !== "object" || c.providers === null || Array.isArray(c.providers)) fail("providers", "expected an object of named providers");
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(c.providers)) providers[name] = parseProvider(name, value);
  if (c.default !== undefined && (typeof c.default !== "string" || !providers[c.default])) fail("default", "name one of the configured providers");
  return c.default === undefined ? { providers } : { providers, default: c.default as string };
}

export async function loadConfig(home = adecHome()): Promise<Config> {
  return parseConfig(await readJsonBounded(join(home, "config.json"), CONFIG_BYTES, "configuration"));
}

export function selectProvider(config: Config, name?: string): ProviderConfig {
  const chosen = name ?? config.default ?? (Object.keys(config.providers).length === 1 ? Object.keys(config.providers)[0] : undefined);
  const provider = chosen === undefined ? undefined : config.providers[chosen];
  if (!provider) throw new UsageError(`provider: ${chosen === undefined ? "none selected" : `unknown provider ${JSON.stringify(chosen)}`}; pass --provider NAME or set "default" in config.json (see adec providers)`);
  return provider;
}

/** The single place a provider key is read. The key is never logged or echoed. */
export async function readKey(provider: ProviderConfig): Promise<string | undefined> {
  if (!provider.keyFile) return undefined;
  const key = (await readTextBounded(provider.keyFile, KEY_BYTES, `provider ${provider.name} key file`)).trim();
  if (!key || /\s/.test(key)) throw new UsageError(`provider ${provider.name} key file: it must hold only the key on one line`);
  return key;
}
