# agent-decide (`adec`)

Decision layer for the agent family (ahub, amem, vmem, acon, ares): typed decisions over System One decision models, with probabilities, margins, calibrated abstention and a content-free shadow log; model routing (alias and reasoning effort) behind policy files; a loopback server and a stdio MCP server (issue #1).

A decision is a proposal. adec never executes, applies or enforces it, and it never decides PII screening, task assignment, "whether to" escalate, review feedback or approvals.

## Install

Requires Bun >= 1.4.2. From a checkout: `bun install --frozen-lockfile`, then run `bin/adec.js`.

## Configuration

`$ADEC_HOME/config.json` (default `~/.adec/config.json`):

```json
{
  "providers": {
    "local": { "kind": "logits", "endpoint": "http://127.0.0.1:8000", "model": "qwen3.5-4b-instruct", "onPrem": true },
    "kev": { "kind": "systemone", "endpoint": "https://decider.example", "model": "kev-4b-v2", "keyFile": "/abs/path/key", "onPrem": false }
  },
  "default": "local"
}
```

- `kind`: `systemone` posts to `{endpoint}/v1/systemone` (TypeSafe-compatible servers: hosted Jev, or self-hosted Kev, Decision 3.0, Clef-flash, pplx-decider through vLLM, llama.cpp, Ollama or SGLang). `logits` reads label-token log-probabilities from `{endpoint}/v1/chat/completions` of any OpenAI-compatible server that returns `top_logprobs`, so an open model you already serve becomes a decider without training.
- `model` is a pinned name; `latest` and `*-latest` are refused.
- `onPrem: true` only for a decider on your own network. A request marked `--pii` to a provider that is not on-prem abstains with `off_prem`; nothing is sent and the key is not read.
- `keyFile` holds only the key. It is sent as a bearer token and never printed, logged or written to the shadow log. Redirects are refused.
- Plain `http` endpoints are accepted only for loopback or on-prem providers. Optional `timeoutMs` (default 4000) and `maxStateChars` (default 8000).
- Optional `version` (pinned, no `latest`) and `sha256` (64 lowercase hex, for local weights). Provider name, kind, model, version and endpoint together key a calibration fit.

## Questions

```json
{ "questionId": "ahub.triage.v1", "instructions": "Label the software task with one class.",
  "options": [ { "id": "implement", "description": "write or change code" }, { "id": "review" }, { "id": "plan" } ] }
```

2 to 26 options with ids of `a-z 0-9 _ -`. Only `choice` questions exist in this phase. The state is evidence, not instructions; adec says so in every question, but injection resistance is not claimed.

## Commands

- `adec ask --question FILE (--state TEXT | --state-file FILE | --state -) [--pii] [--min-margin X] [--provider NAME] [--json]`: ask one question. Exit 0 with a choice, 3 when abstaining, 2 on a usage or configuration error. The decision carries the probabilities over the options, `margin` (top-1 minus top-2, computed by adec; the server's own `confidence` is not used), `abstain` with a closed `reason` (`ok`, `low_margin`, `off_prem`, `timeout`, `http`, `malformed`, `outside_options`, `state_too_long`), `labelMass` for the logits provider, and the decider's provider, model and latency. `choice` is null whenever `abstain` is true; a failure is never turned into a default answer.
- `adec eval --question FILE --set FILE [--provider NAME] [--limit N] [--min-margin X] [--json]`: replay a JSONL set of `{"state", "label", "pii"?}` rows sequentially. Reports accuracy over answered rows, coverage, macro-F1, ECE (10 bins on the top probability), multi-class Brier, p50/p95 latency and abstentions by reason. PII rows are skipped for off-prem providers. Writes no shadow records.
- `adec shadow label <id> <label> [--json]`: record what actually happened: for a decision, one of its option ids or `accepted`, `rejected`, `unknown`; for a route, `completed`, `failed`, `retried` or `unknown`.
- `adec shadow report [--json]`: per question, decisions, abstentions by reason, labelled count and agreement between choices and outcome labels; per routing policy, routes by reason, fallbacks, pins and outcome labels.
- `adec providers [--json]`: configured providers (never keys).
- `adec models [--json]`: the registry view: providers with version and sha256, and per question the newest fit, `fitted` when it still applies or `stale` when the provider's model, version, kind or endpoint changed since.
- `adec calibrate --question FILE --set FILE [--provider NAME] [--target-accuracy X] [--confirm] [--json]`: run the provider over a labelled set (same format as `eval`), fit a temperature and the smallest margin threshold whose answered rows reach the target accuracy (default 0.9). Rows split 70/30 by row hash: fit on 70%, report raw and calibrated accuracy, coverage, selective accuracy, ECE and Brier on 30%. At least 50 rows must get probabilities. Without `--confirm` it is a preview and writes nothing; with it the fit is appended to `$ADEC_HOME/calibration/fits.jsonl` and `ask`, the server and MCP apply it from the next call (tempered probabilities and margin, the fit's threshold unless `--min-margin` is given, `calibration` in the decision). `eval` keeps reporting raw probabilities.
- `adec route --request FILE|- [--json]`: choose a model alias and effort from a policy (below). Exit 0 with a pick (a fallback included), 3 with `no_candidate`. The CLI never pins.
- `adec serve [--port N] [--host 127.0.0.1|::1]`: the loopback server (below). SIGHUP reloads configuration, policies and fits; SIGINT stops.
- `adec mcp`: stdio MCP server with the tools `adec_ask`, `adec_route`, `adec_models`, `adec_shadow_label` and `adec_shadow_report`. Inputs are checked by the same functions as the CLI, and a usage error returns the CLI's message.

## Routing

Policy file `$ADEC_HOME/policies/<policyId>.json` (policyId of at most 50 characters):

```json
{ "policyId": "ahub.chat", "provider": "local", "instructions": "Pick the cheapest model and effort that can finish this turn well.",
  "candidates": [ { "alias": "fast", "efforts": ["low", "medium"], "onPrem": true, "description": "small local model", "costEstimate": 0 },
                  { "alias": "gpt-5.5", "efforts": ["medium", "high"], "onPrem": false, "ctxMax": 200000, "costEstimate": 1.0 } ],
  "default": { "alias": "fast", "effort": "medium" }, "contextLimit": 20000, "minMargin": 0.2 }
```

Candidates are ordered cheapest first; at most 26 alias x effort pairs. `provider` names the decider in `config.json`. `costEstimate` is reported as `estimatedCost`, an estimate. `minMargin` is the route threshold; route questions are not calibrated, since their outcome labels do not name a correct option.

Request:

```json
{ "policyId": "ahub.chat", "turnId": "t-123", "evidence": "<bounded text>",
  "constraints": { "contextTokens": 12000, "pii": false, "private": false,
                   "explicit": { "alias": "gpt-5.5", "effort": "high" }, "current": { "alias": "fast", "effort": "medium" } },
  "candidates": ["fast", "gpt-5.5"] }
```

Rules, in order, each listed in `rules` when applied:

1. `pii` or `private`: on-prem candidates only (`onprem_only`). An off-prem decider is not asked; the request is not built.
2. `explicit`: answered as is when it survived rule 1 (an explicit pair outside the policy is a usage error; one removed by rule 1 gives `no_candidate`).
3. Above `contextLimit` with a `current` policy alias: nothing ranked below it (`no_downgrade`). Candidates whose `ctxMax` is below `contextTokens` go (`ctx_max`).
4. Nothing left: `alias: null`, reason `no_candidate`; keep your current route.
5. A pin for (policy, turn) that still satisfies the rules is reused (`pinned`); otherwise `pin_broken` and the turn is decided again.
6. One pair left: answered without a question (`single`).
7. The decider chooses among the surviving pairs; any abstention applies the fallback: the policy default if it survived, else the first surviving pair, with `fallbackApplied: true`.

`candidates` in a request only narrows the policy's list; an alias outside it is a usage error. Response: `{ id, policyId, alias, effort, margin, abstain, reason, fallbackApplied, pinned, rules, estimatedCost?, decider }`. Apply `alias` and `effort` yourself; adec never calls the model.

## Server

`adec serve` binds `127.0.0.1` (or `::1`) only and has no authentication. It refuses requests with an `Origin` header, a `Host` other than the loopback address and port, a non-JSON body or a body over 64 KB.

- `POST /v1/systemone`: a System One request plus `adec: { questionId, pii?, minMargin? }`; `model` names a configured provider (default when omitted). The answer is the System One shape (`answers.decision.confidence` is the adec margin) plus the full decision under `adec`.
- `POST /v1/route`: the routing request above. Pins live in the server's memory for 30 minutes from last use (at most 10,000), never on disk.
- `GET /v1/health`: `{ ok, version }`.

Caller mistakes are 400 with the usage message; decision failures are 200 with `abstain`. Responses never carry keys, state, evidence or instructions.

## Shadow log

`$ADEC_HOME/shadow/YYYY-MM.jsonl`, append-only, mode 0600. Each decision row holds the id, time, questionId, option ids, choice, margin, abstention and reason, provider, model, latency, label mass and the sha256 of the state. It never holds the state, the instructions or option descriptions. Route rows hold the policy, the pick, the reason and rules, pin and fallback flags, the context size and the sha256 of the turn id and the evidence. `adec shadow label` takes a route id with `completed`, `failed`, `retried` or `unknown`; `adec shadow report --json` returns `{ questions, policies }`.

## License

MIT, STAIx Inc.
