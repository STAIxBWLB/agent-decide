import { createHash, randomBytes } from "node:crypto";
import { checkProvider, type ProviderConfig } from "./config.ts";
import { fields, UsageError, type Decider, type Question, type Reason } from "./contract.ts";
import { decide, type DecideOptions } from "./decide.ts";
import { pairsOf, parsePair, parsePolicy, POLICY_ID, type Pair, type Policy } from "./policy.ts";
import { appendRoute } from "./shadow.ts";

/** POST /v1/route body (spec #4). The candidate list comes from the policy; `candidates` may only narrow it. */
export interface RouteRequest {
  policyId: string;
  turnId?: string;
  evidence: string;
  constraints: { contextTokens: number; pii?: boolean; private?: boolean; explicit?: Pair; current?: Pair };
  candidates?: string[];
}
export type RouteReason = Reason | "explicit" | "pinned" | "single" | "no_candidate";
/** Every rule that filtered the pairs or decided the answer, in the order applied. */
export type RouteRule = "onprem_only" | "explicit" | "no_downgrade" | "ctx_max" | "no_candidate" | "pin_broken" | "pinned" | "single";
export interface RouteDecision {
  id: string; policyId: string; alias: string | null; effort: string | null; margin: number; abstain: boolean;
  reason: RouteReason; fallbackApplied: boolean; pinned: boolean; rules: RouteRule[];
  estimatedCost?: number; decider: Decider | null; error?: string;
}

const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * In-memory pins: one pick per (policy, turn), kept through the tool loop. Never written to disk.
 * The TTL slides on use, so a long tool loop keeps its pick; the oldest entry goes first past `max`.
 */
export class PinStore {
  private readonly map = new Map<string, { pair: Pair; at: number }>();
  constructor(private readonly ttlMs = 30 * 60_000, private readonly max = 10_000, private readonly now = () => Date.now()) {}
  get(key: string): Pair | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    if (this.now() - e.at > this.ttlMs) return undefined;
    this.map.set(key, { pair: e.pair, at: this.now() });
    return e.pair;
  }
  set(key: string, pair: Pair): void {
    this.map.delete(key);
    this.map.set(key, { pair, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export function parseRouteRequest(raw: unknown): RouteRequest {
  const r = fields(raw, ["policyId", "turnId", "evidence", "constraints", "candidates"], "route request");
  if (typeof r.policyId !== "string" || !POLICY_ID.test(r.policyId)) throw new UsageError("route request.policyId: name a policy file in ADEC_HOME/policies");
  if (r.turnId !== undefined && (typeof r.turnId !== "string" || !TURN_ID.test(r.turnId))) throw new UsageError("route request.turnId: use 1-128 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-'");
  if (typeof r.evidence !== "string") throw new UsageError("route request.evidence: give the bounded evidence as a string");
  const c = fields(r.constraints, ["contextTokens", "pii", "private", "explicit", "current"], "route request.constraints");
  if (typeof c.contextTokens !== "number" || !Number.isInteger(c.contextTokens) || c.contextTokens < 0) throw new UsageError("route request.constraints.contextTokens: give the turn's context size as a non-negative integer");
  for (const k of ["pii", "private"] as const) if (c[k] !== undefined && typeof c[k] !== "boolean") throw new UsageError(`route request.constraints.${k}: give true or false`);
  let candidates: string[] | undefined;
  if (r.candidates !== undefined) {
    if (!Array.isArray(r.candidates) || !r.candidates.length) throw new UsageError("route request.candidates: give a non-empty list of policy aliases, or leave it out");
    candidates = r.candidates.map((a, i) => parsePair({ alias: a, effort: "x" }, `route request.candidates[${i}]`).alias);
  }
  return {
    policyId: r.policyId, ...(r.turnId === undefined ? {} : { turnId: r.turnId as string }), evidence: r.evidence,
    constraints: {
      contextTokens: c.contextTokens, ...(c.pii === undefined ? {} : { pii: c.pii as boolean }), ...(c.private === undefined ? {} : { private: c.private as boolean }),
      ...(c.explicit === undefined ? {} : { explicit: parsePair(c.explicit, "route request.constraints.explicit") }),
      ...(c.current === undefined ? {} : { current: parsePair(c.current, "route request.constraints.current") }),
    },
    ...(candidates ? { candidates } : {}),
  };
}

export interface RouteOptions extends Pick<DecideOptions, "key"> { shadowDir: string | null; pins?: PinStore }

function checkOptions(options: RouteOptions): void {
  const o = fields(options, ["shadowDir", "key", "pins"], "route options");
  if (o.shadowDir !== null && (typeof o.shadowDir !== "string" || !o.shadowDir)) throw new UsageError("route options.shadowDir: give a directory path, or null to write no shadow record");
  if (o.key !== undefined && typeof o.key !== "function") throw new UsageError("route options.key: give a function or leave it out");
  if (o.pins !== undefined && !(o.pins instanceof PinStore)) throw new UsageError("route options.pins: pins are kept by adec serve; leave it out");
}

const same = (a: Pair) => (b: Pair) => a.alias === b.alias && a.effort === b.effort;

/**
 * Choose an alias and effort from the policy. Hard rules first, in the spec's order; the decider only chooses among
 * what survives; any decider failure applies the fallback. A proposal only: the consumer applies it.
 */
export async function route(request: RouteRequest, policy: Policy, provider: ProviderConfig, options: RouteOptions): Promise<RouteDecision> {
  const req = parseRouteRequest(request);
  policy = parsePolicy(policy);
  provider = checkProvider(provider);
  checkOptions(options);
  if (req.policyId !== policy.policyId) throw new UsageError(`route: the request names policy ${req.policyId} but policy ${policy.policyId} was given`);
  if (provider.name !== policy.provider) throw new UsageError(`route: policy ${policy.policyId} names provider ${policy.provider}, not ${provider.name}`);
  const c = req.constraints, all = pairsOf(policy), rules: RouteRule[] = [];
  const id = randomBytes(16).toString("hex");
  const pinKey = options.pins && req.turnId !== undefined ? `${policy.policyId}\n${req.turnId}` : undefined;

  const finish = async (pick: Pair | null, reason: RouteReason, extra: { margin?: number; fallbackApplied?: boolean; pinned?: boolean; decider?: Decider | null; error?: string } = {}): Promise<RouteDecision> => {
    const fallbackApplied = extra.fallbackApplied ?? false, pinned = extra.pinned ?? false;
    if (reason === "explicit" || reason === "no_candidate" || reason === "pinned" || reason === "single") rules.push(reason);
    const cost = pick ? policy.candidates.find(k => k.alias === pick.alias)?.costEstimate : undefined;
    const d: RouteDecision = {
      id, policyId: policy.policyId, alias: pick?.alias ?? null, effort: pick?.effort ?? null, margin: extra.margin ?? 0,
      abstain: pick === null || fallbackApplied, reason, fallbackApplied, pinned, rules,
      ...(cost === undefined ? {} : { estimatedCost: cost }), decider: extra.decider ?? null, ...(extra.error === undefined ? {} : { error: extra.error }),
    };
    if (pick && pinKey && reason !== "explicit" && !pinned) options.pins!.set(pinKey, { alias: pick.alias, effort: pick.effort });
    if (options.shadowDir !== null) await appendRoute(options.shadowDir, {
      v: 1, kind: "route", id, at: new Date().toISOString(), policyId: policy.policyId,
      ...(req.turnId === undefined ? {} : { turnIdSha256: sha(req.turnId) }), alias: d.alias, effort: d.effort, reason, rules,
      fallbackApplied, pinned, margin: d.margin, contextTokens: c.contextTokens, pii: !!(c.pii || c.private),
      ...(d.decider ? { provider: d.decider.provider, model: d.decider.model, latencyMs: d.decider.latencyMs } : {}), evidenceSha256: sha(req.evidence),
    });
    return d;
  };

  let pairs = all;
  if (req.candidates) {
    const unknown = req.candidates.filter(a => !policy.candidates.some(k => k.alias === a));
    if (unknown.length) throw new UsageError(`route request.candidates: ${unknown.join(", ")} not in policy ${policy.policyId}; a request can narrow the policy's candidates, never widen them`);
    pairs = pairs.filter(p => req.candidates!.includes(p.alias));
  }
  if (c.explicit && !pairs.some(same(c.explicit))) throw new UsageError(`route request.constraints.explicit: ${c.explicit.alias}/${c.explicit.effort} is not an allowed pair of policy ${policy.policyId}`);
  // 1. PII or private: on-prem candidates only (before the explicit pick, so an off-prem pick never comes back).
  const sensitive = !!(c.pii || c.private);
  if (sensitive) { rules.push("onprem_only"); pairs = pairs.filter(p => p.onPrem); }
  // 2. An explicit pick wins when it survived step 1.
  if (c.explicit) return pairs.some(same(c.explicit)) ? finish(c.explicit, "explicit") : finish(null, "no_candidate", { margin: 0 });
  // 3. Above the context limit, never below the current alias (prompt cache); candidates too small for the context go.
  const currentRank = c.current ? policy.candidates.findIndex(k => k.alias === c.current!.alias) : -1;
  if (c.contextTokens > policy.contextLimit && currentRank >= 0) { rules.push("no_downgrade"); pairs = pairs.filter(p => p.rank >= currentRank); }
  const before = pairs.length;
  pairs = pairs.filter(p => p.ctxMax === undefined || p.ctxMax >= c.contextTokens);
  if (pairs.length < before) rules.push("ctx_max");
  // 4. Nothing left: the consumer keeps its own route.
  if (!pairs.length) return finish(null, "no_candidate");
  // 5. The turn's pin, while it still satisfies the rules.
  if (pinKey) {
    const pin = options.pins!.get(pinKey);
    if (pin && pairs.some(same(pin))) return finish(pin, "pinned", { pinned: true });
    if (pin) rules.push("pin_broken");
  }
  // 6. One pair: no question.
  if (pairs.length === 1) return finish(pairs[0]!, "single");
  // 7. Ask the decider; 8. any abstention applies the fallback.
  const fallback = pairs.find(same(policy.default)) ?? pairs[0]!;
  // An off-prem decider on a PII or private turn: no question and no request are built.
  if (sensitive && !provider.onPrem) return finish(fallback, "off_prem", { fallbackApplied: true });
  const question: Question = {
    questionId: `adec.route.${policy.policyId}.v1`, instructions: policy.instructions,
    options: pairs.map((p, i) => {
      const desc = policy.candidates[p.rank]!.description;
      return { id: `p${i + 1}`, description: `${desc ? `${desc}; ` : ""}model ${p.alias}, effort ${p.effort}` };
    }),
  };
  const d = await decide({ question, state: req.evidence, pii: sensitive, minMargin: policy.minMargin }, provider, { shadowDir: null, ...(options.key ? { key: options.key } : {}) });
  // No request was built for an over-long state; report no decider.
  const decider = d.reason === "state_too_long" ? null : d.decider;
  if (d.choice !== null) return finish(pairs[Number(d.choice.slice(1)) - 1]!, "ok", { margin: d.margin, decider });
  return finish(fallback, d.reason, { margin: d.margin, fallbackApplied: true, decider, ...(d.error === undefined ? {} : { error: d.error }) });
}
