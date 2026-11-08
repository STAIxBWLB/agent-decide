# agent-decide (`adec`)

Decision layer for the agent family (ahub, amem, vmem, acon, ares): typed decisions over System One decision models, with probabilities, margins, abstention and a content-free shadow log. Model routing, a server, calibration fitting and a model registry follow in later phases (issue #1).

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

## Questions

```json
{ "questionId": "ahub.triage.v1", "instructions": "Label the software task with one class.",
  "options": [ { "id": "implement", "description": "write or change code" }, { "id": "review" }, { "id": "plan" } ] }
```

2 to 26 options with ids of `a-z 0-9 _ -`. Only `choice` questions exist in this phase. The state is evidence, not instructions; adec says so in every question, but injection resistance is not claimed.

## Commands

- `adec ask --question FILE (--state TEXT | --state-file FILE | --state -) [--pii] [--min-margin X] [--provider NAME] [--json]`: ask one question. Exit 0 with a choice, 3 when abstaining, 2 on a usage or configuration error. The decision carries the probabilities over the options, `margin` (top-1 minus top-2, computed by adec; the server's own `confidence` is not used), `abstain` with a closed `reason` (`ok`, `low_margin`, `off_prem`, `timeout`, `http`, `malformed`, `outside_options`, `state_too_long`), `labelMass` for the logits provider, and the decider's provider, model and latency. `choice` is null whenever `abstain` is true; a failure is never turned into a default answer.
- `adec eval --question FILE --set FILE [--provider NAME] [--limit N] [--min-margin X] [--json]`: replay a JSONL set of `{"state", "label", "pii"?}` rows sequentially. Reports accuracy over answered rows, coverage, macro-F1, ECE (10 bins on the top probability), multi-class Brier, p50/p95 latency and abstentions by reason. PII rows are skipped for off-prem providers. Writes no shadow records.
- `adec shadow label <id> <label> [--json]`: record what actually happened for a decision: one of its option ids, or `accepted`, `rejected`, `unknown`.
- `adec shadow report [--json]`: per question, decisions, abstentions by reason, labelled count and agreement between choices and outcome labels.
- `adec providers [--json]`: configured providers (never keys).

## Shadow log

`$ADEC_HOME/shadow/YYYY-MM.jsonl`, append-only, mode 0600. Each decision row holds the id, time, questionId, option ids, choice, margin, abstention and reason, provider, model, latency, label mass and the sha256 of the state. It never holds the state, the instructions or option descriptions.

## License

MIT, STAIx Inc.
