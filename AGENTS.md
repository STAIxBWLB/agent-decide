# agent-decide

- Implement the accepted issue contract (the phase's child spec under #1) on a branch with a PR. Change the spec first when the code must differ.
- Source is in `src/`, the bootstrap in `bin/`, checks in `scripts/`, tests and synthetic fixtures in `test/`.
- Strict TypeScript, `.ts` imports, `noUncheckedIndexedAccess`. Runtime imports: relative files, Node builtins and `bun:` only (`scripts/check-boundary.ts`).
- `src/index.ts` exports entry points only, by name (no `export *`). Every exported entry point re-validates what it receives through the same `parse*`/`check*` function the CLI uses (`parseQuestion`, `parseRow`, `checkProvider`, `parseMinMargin`); a TypeScript type is not validation. Add new public inputs to the table in `test/public-api.test.ts`.
- `src/commands-table.ts` is the single CLI source; the CLI reads usage and options from it. Add a command there first.
- Verify with `bun install --frozen-lockfile && bun run check`. Passing output ends with `boundary: ok`, `0 fail` and the package dry-run listing.
- Tests never touch the network: provider tests use fake servers on loopback (`Bun.serve`).
- Never write a provider key, request body, state text, instructions or option descriptions to the shadow log, errors or command output. Errors name the provider, the cause class and the HTTP status only.
- A decision is a proposal. Never add a path that executes, applies or auto-enforces a decision, or that decides PII screening, task assignment, "whether to" escalate, review feedback or approvals.
- A PII or private request never reaches a provider that is not `onPrem`; the request is not even built.
- No moving model aliases (`latest`, `*-latest`); provider models are pinned names.
- Keep unimplemented phases out of the CLI and README command list.
- Conventional English commits, no coauthor trailers unless requested.
