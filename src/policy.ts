import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_OPTIONS, UsageError } from "./contract.ts";
import { readJsonBounded } from "./io.ts";

/** A routing policy file, $ADEC_HOME/policies/<policyId>.json (spec #4). Candidates are ordered cheapest first. */
export interface Candidate { alias: string; efforts: string[]; onPrem: boolean; ctxMax?: number; description?: string; costEstimate?: number }
export interface Pair { alias: string; effort: string }
export interface Policy {
  policyId: string; provider: string; instructions: string; candidates: Candidate[];
  default: Pair; contextLimit: number; minMargin: number;
}

/** At most 50 characters, so the route questionId adec.route.<policyId>.v1 fits the 64-character questionId limit. */
export const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const ALIAS = /^[a-z0-9][a-z0-9._/:-]{0,63}$/, EFFORT = /^[a-z0-9][a-z0-9_-]{0,15}$/, PROVIDER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const POLICY_BYTES = 64 * 1024;
const MAX_CANDIDATE_DESCRIPTION = MAX_DESCRIPTION - 100; // room for "; model <alias>, effort <effort>" in the option description

function obj(raw: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${where}: expected a JSON object`);
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) throw new UsageError(`${where}: unknown field ${unknown.map(k => JSON.stringify(k)).join(", ")}; allowed fields are ${allowed.join(", ")}`);
  return raw as Record<string, unknown>;
}

export function parsePair(raw: unknown, where: string): Pair {
  const p = obj(raw, ["alias", "effort"], where);
  if (typeof p.alias !== "string" || !ALIAS.test(p.alias)) throw new UsageError(`${where}.alias: use 1-64 characters of a-z, 0-9, '.', '_', '/', ':' or '-', starting with a letter or digit`);
  if (typeof p.effort !== "string" || !EFFORT.test(p.effort)) throw new UsageError(`${where}.effort: use 1-16 characters of a-z, 0-9, '_' or '-', starting with a letter or digit`);
  return { alias: p.alias, effort: p.effort };
}

/** Every alias x effort pair in policy order; `rank` is the candidate's position (higher is more capable). */
export function pairsOf(policy: Policy): (Pair & { rank: number; onPrem: boolean; ctxMax?: number })[] {
  return policy.candidates.flatMap((c, rank) => c.efforts.map(effort => ({ alias: c.alias, effort, rank, onPrem: c.onPrem, ...(c.ctxMax === undefined ? {} : { ctxMax: c.ctxMax }) })));
}

/** Validate a policy; with a configuration, its provider must be configured. */
export function parsePolicy(raw: unknown, config?: Config): Policy {
  const p = obj(raw, ["policyId", "provider", "instructions", "candidates", "default", "contextLimit", "minMargin"], "policy");
  if (typeof p.policyId !== "string" || !POLICY_ID.test(p.policyId)) throw new UsageError("policy.policyId: use 1-50 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit");
  const where = `policy ${p.policyId}`;
  if (typeof p.provider !== "string" || !PROVIDER.test(p.provider)) throw new UsageError(`${where}.provider: name a provider from config.json`);
  if (config && !Object.hasOwn(config.providers, p.provider)) throw new UsageError(`${where}.provider: ${JSON.stringify(p.provider)} is not in config.json; see adec providers`);
  if (typeof p.instructions !== "string" || !p.instructions.trim() || p.instructions.length > MAX_INSTRUCTIONS)
    throw new UsageError(`${where}.instructions: give a non-empty string of at most ${MAX_INSTRUCTIONS} characters`);
  if (!Array.isArray(p.candidates) || !p.candidates.length) throw new UsageError(`${where}.candidates: list at least one candidate, cheapest first`);
  const seen = new Set<string>();
  const candidates: Candidate[] = p.candidates.map((rawC, i) => {
    const at = `${where}.candidates[${i}]`;
    const c = obj(rawC, ["alias", "efforts", "onPrem", "ctxMax", "description", "costEstimate"], at);
    const efforts = Array.isArray(c.efforts) ? c.efforts : [];
    if (!efforts.length) throw new UsageError(`${at}.efforts: list at least one effort`);
    efforts.forEach((e, j) => parsePair({ alias: c.alias, effort: e }, `${at}.efforts[${j}]`));
    if (new Set(efforts).size !== efforts.length) throw new UsageError(`${at}.efforts: efforts must be unique`);
    const alias = parsePair({ alias: c.alias, effort: efforts[0] }, at).alias;
    if (seen.has(alias)) throw new UsageError(`${at}.alias: duplicate alias ${JSON.stringify(alias)}`);
    seen.add(alias);
    if (typeof c.onPrem !== "boolean") throw new UsageError(`${at}.onPrem: set true only for a model served on your own network, false otherwise`);
    if (c.ctxMax !== undefined && (typeof c.ctxMax !== "number" || !Number.isInteger(c.ctxMax) || c.ctxMax < 1)) throw new UsageError(`${at}.ctxMax: give a positive integer token count`);
    if (c.description !== undefined && (typeof c.description !== "string" || c.description.length > MAX_CANDIDATE_DESCRIPTION || /[\r\n]/.test(c.description)))
      throw new UsageError(`${at}.description: give a single-line string of at most ${MAX_CANDIDATE_DESCRIPTION} characters`);
    if (c.costEstimate !== undefined && (typeof c.costEstimate !== "number" || !Number.isFinite(c.costEstimate) || c.costEstimate < 0)) throw new UsageError(`${at}.costEstimate: give a non-negative number`);
    return { alias, efforts: efforts as string[], onPrem: c.onPrem,
      ...(c.ctxMax === undefined ? {} : { ctxMax: c.ctxMax as number }), ...(c.description === undefined ? {} : { description: c.description as string }),
      ...(c.costEstimate === undefined ? {} : { costEstimate: c.costEstimate as number }) };
  });
  const count = candidates.reduce((s, c) => s + c.efforts.length, 0);
  if (count > MAX_OPTIONS) throw new UsageError(`${where}.candidates: ${count} alias x effort pairs; at most ${MAX_OPTIONS} fit in one question`);
  const fallback = parsePair(p.default, `${where}.default`);
  if (!candidates.some(c => c.alias === fallback.alias && c.efforts.includes(fallback.effort))) throw new UsageError(`${where}.default: name one of the candidate alias x effort pairs`);
  const contextLimit = p.contextLimit === undefined ? 20_000 : p.contextLimit;
  if (typeof contextLimit !== "number" || !Number.isInteger(contextLimit) || contextLimit < 1) throw new UsageError(`${where}.contextLimit: give a positive integer token count (default 20000)`);
  const minMargin = p.minMargin === undefined ? 0 : p.minMargin;
  if (typeof minMargin !== "number" || !Number.isFinite(minMargin) || minMargin < 0 || minMargin > 1) throw new UsageError(`${where}.minMargin: give a number from 0 to 1`);
  return { policyId: p.policyId, provider: p.provider, instructions: p.instructions, candidates, default: fallback, contextLimit, minMargin };
}

export function policiesDir(home: string): string { return join(home, "policies"); }

export async function loadPolicy(home: string, policyId: string, config: Config): Promise<Policy> {
  if (typeof policyId !== "string" || !POLICY_ID.test(policyId)) throw new UsageError("policyId: use 1-50 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit");
  const policy = parsePolicy(await readJsonBounded(join(policiesDir(home), `${policyId}.json`), POLICY_BYTES, `policy ${policyId}`), config);
  if (policy.policyId !== policyId) throw new UsageError(`policy ${policyId}: the file's policyId is ${JSON.stringify(policy.policyId)}; rename the file or fix policyId`);
  return policy;
}

/** Every policy in $ADEC_HOME/policies (for the server); no directory is no policies. */
export async function loadPolicies(home: string, config: Config): Promise<Map<string, Policy>> {
  let files: string[];
  try { files = (await readdir(policiesDir(home))).filter(f => f.endsWith(".json")).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw new UsageError(`policies: cannot read ${policiesDir(home)}; check the directory`); }
  const out = new Map<string, Policy>();
  for (const f of files) { const id = f.slice(0, -5); out.set(id, await loadPolicy(home, id, config)); }
  return out;
}
