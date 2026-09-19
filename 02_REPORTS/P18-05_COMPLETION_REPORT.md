# Completion Report

Prompt ID: P18-05 Add online/adaptive research safely
Phase: P18 Advanced Alpha
Date/time UTC: 2026-09-13T00:55:00Z
Branch/commit: main (uncommitted working tree; commit deferred to owner)

## What changed

Adaptive research (`contracts/src/advancedAlpha/adaptiveResearch.ts`):
- Shadow experiments hold a VERSIONED weight vector; every update bumps `weightsVersion` by exactly 1 and appends an immutable event (`adup_` content-addressed).
- `stepWeights`: bounded online step `new = old + lr * (target - old)` clamped to [0,1], learningRate in (0,1], identical component ids enforced.
- `replayAdaptiveExperiment`: idempotent fold — same initial state + same events -> identical final state; enforces strictly ascending UTC instants, version+1 bumps, experimentId match, shadow-only weight updates, shadow-only promotion, terminal absorption (retired accepts nothing).
- Mode gating: `ADAPTIVE_MODES = ["research", "paper"]` — `live` is ABSENT from the schema, so online changes can never silently affect live behavior.
- Promotion requires a P18-02 gate assessment id (`mlgate_...`) on the explicit promotion event; retirement carries a reason and is terminal.

## Files changed

- `contracts/src/advancedAlpha/metaLabeling.ts` (new, P18-01)
- `contracts/src/advancedAlpha/mlChallenger.ts` (new, P18-02)
- `contracts/src/advancedAlpha/providerCompare.ts` (new, P18-03)
- `contracts/src/advancedAlpha/portfolioIntel.ts` (new, P18-04)
- `contracts/src/advancedAlpha/adaptiveResearch.ts` (new, P18-05)
- `contracts/src/advancedAlpha/featureSandbox.ts` (new, P18-06)
- `contracts/src/advancedAlpha/util.ts` (new, shared FNV-1a64 + round6)
- `contracts/src/advancedAlpha/index.ts` (new barrel)
- `contracts/src/index.ts` (advancedAlpha barrel export)
- `contracts/src/__tests__/advanced-alpha.test.ts` (new, 20 tests)
- `docs/adr/ADR-0032-advanced-alpha-research-layer.md` (new)
- `docs/adr/README.md` (ADR-0032 indexed)
- `tests/test_ci_contracts.py` (ADR-0032 registered)

## Tests executed

- `pnpm --filter @fdbtrade/contracts exec vitest run src/__tests__/advanced-alpha.test.ts` — 20/20 green (this prompt's scope).
- `pnpm --filter @fdbtrade/contracts exec vitest run` — 43 files / 631 tests green (no regression).
- `pnpm --filter @fdbtrade/contracts exec tsc --noEmit` — 0 errors.
- `pnpm --filter @fdbtrade/contracts exec eslint src/advancedAlpha src/__tests__/advanced-alpha.test.ts` — exit 0 (pre-existing repo warnings only).
- `python3 -m unittest tests.test_ci_contracts` — 18/18 green (ADR-0032 registered, contiguous numbering verified).
- `python3 -m unittest discover tests` — 476/476 green.

## Acceptance criteria

- [x] Online changes are versioned (weightsVersion +1 per update; immutable event log).
- [x] Can be replayed (idempotent fold verified by test).
- [x] Never silently affect live behavior (live mode absent from the schema; weight updates stop at promotion; retirement terminal).
- [x] No autonomous live self-modification (promotion requires an explicit gate-linked event).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck clean for affected packages.
- [x] No unrelated files modified without justification.
- [x] Completion report written.

## Known limitations / blockers

- Contract-layer only: no training loops, no model hosting, no provider fetching — callers supply outcomes/scores/observations/evidence at the boundary (same approach as P15-P17).
- MT5 terminal absent on the Linux dev host; provider comparison tested against deterministic fixture-shaped observations.
- Python mirrors under `quant/advancedAlpha` deferred (TS contract is the phase source of truth; mirrors were optional per-phase work, not required by the prompt acceptance criteria).
- Persistence of decisions/reports/events is in-memory per process; DB wiring deferred to a later DB-integration prompt.

## Follow-up required before next prompt

- Next prompt per `00_CONTROL/RUN_ORDER.md`: none — P18 is the final blueprint phase. Owner should review the phase-gate report and decide follow-up packs (e.g. Python mirrors, backend wiring, persistence).

## Risk notes

- Trading safety: no broker access anywhere in the advanced-alpha layer; ML production stays OFF by default behind `assessMlGate` (all six checks must pass); adaptive experiments refuse `live` mode at the schema; portfolio selection is advisory and subordinate to the P11 hard risk limits.
- Quant integrity: leakage-safe labels (at-signal-time context enforced); OOS evaluation with P09 split/purge digest provenance; ties never promote; every rejection and verdict carries a machine-readable reason; content-addressed ids make all artifacts replayable; expected edge is an estimate, never a guaranteed profit.
- Security: no secrets in any schema/fixture/log; no external endpoints; deterministic inputs only.
