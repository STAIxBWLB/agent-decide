# Review

- Compare the complete diff with the linked phase spec (child issue of #1) and its acceptance criteria.
- Important: a provider key, request body, state text, instructions or option descriptions reaching the shadow log, an error, an event or command output.
- Important: a PII or private request built or sent to a provider that is not `onPrem`; a moving model alias accepted; a plain `http` endpoint accepted for an off-prem provider.
- Important: a decision returned with `abstain: true` and a non-null `choice`, a choice outside the options, probabilities that do not match the options, or a failure turned into a default answer instead of an abstention.
- Important: unbounded reads (files, stdin, HTTP bodies), unknown fields or options accepted silently, a write before validation.
- Important: a command missing from `src/commands-table.ts`, or CLI behaviour that differs from the library for the same operation.
- Check that tests stay offline and that a test exists for each acceptance criterion it claims.
- Error messages: a new or changed error a person or agent sees names the cause and the next step (the command, setting or file that fixes it). When secrets must stay out, it names the cause class and how to check it.
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling, generated `bun.lock`. At most five nits.
