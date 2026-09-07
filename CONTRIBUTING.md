# Contributing to FdbTrade

FdbTradeis executed as a serial prompt-pack: one prompt = one bounded change.
This document is the primary contribution contract for humans and agents alike.

## Before you start

1. Read `.clinerules/` first — persistent core + workflow rules.
2. Read `04_CLINE_CONTROL/START_HERE.md` and `00_CONTROL/RUN_ORDER.md` — execution handoff and sequence.
3. Read `03_REFERENCE/BLUEPRINT_V2_FROZEN.md` — frozen source of truth.
4. Read the latest `COMPLETION_REPORT.md` — confirm the exact next prompt..
5. Inspect `git status` and the working tree before editing..

## Execution rules

- Execute exactly one prompt per run; do not pull later-phase work forward..
- Preserve existing architecture boundaries; do not rewrite unrelated files..
- Prefer small, reversible changes; run the narrowest relevant tests after each unit, then broader checks before completion..
- Do not change dependencies or stack without an ADR and explicit approval..
- Do not enable live trading or broker order authority from any prompt before P16/P17 gates..
- Never invent credentials, endpoints, or provider access; use fixtures/mocks when credentials are unavailable..

## Engineering contracts

- All internal timestamps are UTC..
- Deterministic behavior is required for deterministic inputs; deterministic entry points are the default (`make` targets..
- Use typed contracts and schema validation at boundaries (e.g., package.json contracts, later API/feature contracts..
- Never put secrets in source, fixtures, logs or browser bundles; `.env*` is git-ignored..
- Strategy code must never call a broker directly; strategy → signal → risk → executionis a hard boundary..
- No look-ahead, leakage, future-derived labels, or hidden test-set optimization in research code..
- Every production bug gets a regression test..

## Tests and checks

- Cross-cutting contract tests live in `tests/` (Python stdlib `unittest`, no extra deps..
- Run the aggregate local gate before completion: `make check` (+ `make install` idempotency when deps change..
- CI baseline arrives in P00-04 and will reuse the same `make` targets..

## Documentation and ownership

- Keep docs and ADRs synchronized with implementation; update `docs/adr/` when a durable architectural decision is made..
- Update `COMPLETION_REPORT.md`, `04_CLINE_CONTROL/CURRENT_STATE.md`, and
  `04_CLINE_CONTROL/START_HERE.md` after each completed prompt..
- Ownership placeholders: see `OWNERS.md`..

## Git discipline (NTFS workspace)

- Workspace is on NTFS via fuseblk: no symlinks, no Unix permission bits..
- Git runs with `core.fileMode=false` and `core.autocrlf=false`; never introduce symlinks or rely on executable bits..
- Prefer a focused commit per prompt; never reset, clean, force-checkout, or rewrite history without explicit user approval..