# P10-04 — Implement reconciliation loop

> Execute only this prompt. Do not implement later phases in the same run.

## Context
You are implementing FdbTrade Private Trading Intelligence OS from the approved Blueprint v2.0. Read:
- `00_CONTROL/AGENT_CONSTITUTION.md`
- `00_CONTROL/RUN_ORDER.md`
- `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`
- the previous prompt completion report, if present

## Goal
Compare derived state with event log and detect drift, missing fills, duplicate events and impossible balances.

## Exact scope
Implement only the subsystem described above. Inspect the existing code first and reuse established contracts. Create or modify the smallest set of files necessary.

## Required implementation rules
1. Preserve existing architecture boundaries.
2. All internal timestamps are UTC.
3. Deterministic behavior is required for deterministic inputs.
4. Use typed contracts and schema validation at boundaries.
5. Never put secrets in source, fixtures, logs or browser bundles.
6. Do not call a broker from strategy, feature, UI or LLM code.
7. Use mocks/fixtures when an external credential is unavailable.
8. Add tests for happy path, edge cases and failure path relevant to this prompt.
9. Do not silently change dependencies or stack.
10. Update docs/ADR only when this prompt creates a durable architectural decision.

## Acceptance criteria
Reconciliation produces actionable discrepancy reason codes.

Additional universal acceptance:
- Relevant tests pass from a clean environment or the blocker is documented.
- Lint/typecheck/build are clean for affected packages.
- No unrelated files are modified without justification.
- Completion report is written.

## Test cases
At minimum, cover:
- valid input / expected output
- malformed or missing input
- boundary/empty/stale case when applicable
- idempotency where events/jobs are involved
- regression fixture for any newly discovered bug

## Non-goals
No automatic destructive repair.
Do not implement functionality outside this prompt or future phases.

## Completion report required
Use `02_TEMPLATES/COMPLETION_REPORT_TEMPLATE.md` and include:
- prompt ID and commit
- files changed
- tests executed and results
- acceptance checklist
- blockers/limitations
- security/quant implications
- exact next prompt that is safe to run
