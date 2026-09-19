# Completion Report

Prompt ID: P18-03 Add multi-provider research comparison
Phase: P18 Advanced Alpha
Date/time UTC: 2026-09-13T00:55:00Z
Branch/commit: main (uncommitted working tree; commit deferred to owner)

## What changed

Multi-provider comparison (`contracts/src/advancedAlpha/providerCompare.ts`):
- Pairwise spread comparison at matched (instrument, timestamp): pip deltas from provider-labeled spread observations; self-comparison and fuzzy matching fail closed.
- Aggregate spread report: matched pairs (deterministic order), mean signed/absolute deltas, and unmatched counts on BOTH sides (coverage gaps visible, never dropped).
- Pairwise candle comparison: OHLC deltas in PIP units (pip size = caller-supplied instrument metadata, never a literal); single-provider series and mixed-provider lists fail closed.
- Aggregate candle report: coverage gaps listed per provider, mean/worst max-abs deltas.
- Timestamp consistency: grid misalignment (P02 timeframe grid), duplicate open times and out-of-order findings — sorted, visible lists; `timeframeMs` is metadata.
- No ground truth: both provider ids recorded on every comparison; deltas signed B - A; no scraping and no unlicensed redistribution (pure computation over caller-supplied observations).

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

- [x] Provider differences are measurable and visible (pips deltas, coverage gaps, timestamp findings — all listed).
- [x] No provider is silently treated as ground truth (pairwise only, both ids recorded).
- [x] No scraping or unlicensed redistribution (comparison operates on already-ingested observations only).
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
