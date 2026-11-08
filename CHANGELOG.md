# Changelog

## Unreleased

- Eval (#6): exclusive content-free per-row JSONL output, validated row ids and tags with slice metrics, wording-flip agreement, paired comparison with exact McNemar and explicitly seeded deterministic bootstrap, public `compareRows`; configured decider version in decisions, routes, shadow records and eval reports.

- D2 (#4): `serve` (loopback HTTP: `/v1/systemone` with the adec extension, `/v1/route`, `/v1/health`; Origin, Host, type and size guards; SIGHUP reload), model routing with policy files, hard rules, in-memory pins and fallback (`route`), temperature and margin-threshold calibration with preview and `--confirm` (`calibrate`), applied by `ask`, the server and MCP; provider `version` and `sha256` with the `models` registry view; stdio MCP (`mcp`); route records and outcome words in the shadow log. `shadow report --json` now returns `{ questions, policies }`.
- D1 (#2): choice-question contract (2 to 26 options), `systemone` and `logits` providers, client-computed margin and abstention with closed reasons, PII refusal for off-prem providers before any request, content-free shadow log with outcome labels and report, offline `eval` (accuracy, coverage, macro-F1, ECE, Brier, latency), CLI `ask`, `eval`, `shadow label`, `shadow report`, `providers`.
