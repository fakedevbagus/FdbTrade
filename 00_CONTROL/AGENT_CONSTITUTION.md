# Agent Operating Constitution

## Execution protocol
1. Execute exactly one prompt file per run.
2. Before editing, inspect repository state, current branch, existing tests, package/runtime versions, and prior `COMPLETION_REPORT.md`.
3. Read `03_REFERENCE/BLUEPRINT_V2_FROZEN.md` and the referenced phase prompt context.
4. Implement only the stated scope.
5. Run the required tests and relevant smoke checks.
6. Update documentation when behavior/contracts change.
7. Write a completion report using `02_TEMPLATES/COMPLETION_REPORT_TEMPLATE.md`.
8. Stop after the prompt's acceptance criteria are met. Do not pre-build later phases.

## Scope discipline
- No unrelated refactor.
- No dependency upgrade unless required by the prompt.
- No silent architecture changes.
- No secret values committed.
- No live broker order submission unless the current prompt explicitly belongs to P16/P17 and all earlier gates are satisfied.
- Use fixture/mock providers when credentials are unavailable.
- External integration failure must degrade safely.

## Quant/research discipline
- All timestamps are UTC internally.
- Symbol mapping, pip size, point value, precision, contract size and session semantics are provider/instrument metadata, never hard-coded assumptions.
- Strategy calculations must be deterministic given the same input snapshot and version.
- Backtests must include transaction costs and explicit fill assumptions.
- ML requires time-aware validation, leakage controls, calibration checks, and a promotion gate.

## Safety boundary
LLM/AI assistant may explain, summarize, inspect and propose. It must not directly submit broker orders. Order submission remains deterministic code behind risk/execution services and explicit phase gates.
