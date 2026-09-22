# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.4 — Authority reset and SQLite foundation**

Next authorized unit: **R0.5 — Local application and runtime lifecycle**

## Resume context

1. Read `artifacts/rebuild/r0.4/sqlite-foundation.json`,
   `docs/rebuild/checkpoints/R0.4_AUTHORITY_RESET_SQLITE_FOUNDATION.md`, and
   ADR-0037.
2. Revalidate branch, HEAD, clean user-change boundaries, the R0.4 gate report,
   and all ten M48 preservation hashes before editing.
3. Keep `scripts/rebuild_toolchain.py` and `make toolchain-gate` as the only
   install/lint/typecheck/test/build authority.
4. Keep SQLite and `backend/src/db/sqlite.mjs` as the only durable-state and
   transaction authority. Do not reintroduce PostgreSQL, Redis or Docker.
5. Keep live execution off, provider-order transport off, and M48 disconnected.

## R0.5 scope

R0.5 may do only the local application/runtime lifecycle unit from the R0.2
dependency order:

- make both local applications start predictably on loopback through one
  bounded operator lifecycle;
- replace duplicate or misleading startup/status/stop authority;
- persist scheduler locks, leases, checkpoints, dedupe and recovery state in
  the canonical SQLite database with explicit transactions;
- prove crash/restart recovery, exclusive ownership, stale-lease takeover,
  idempotent resume and truthful health with hermetic behavior tests;
- update current operator docs, ADR/checkpoint evidence and the next handoff.

## Explicit exclusions

- Do not implement market-data or artifact authority.
- Do not persist feature, regime, strategy, ensemble or signal intelligence.
- Do not rebuild backtest/research, risk, paper broker, outcomes or UI.
- Do not design backup/restore beyond preserving the R0.4 fail-closed gap.
- Do not inspect or clean up the legacy PostgreSQL container/database.
- Do not use credentials, make provider network requests, wire M48, or begin
  credentialed shadow-provider work.

## Entry evidence and known gaps

- R0.4 replaced the external PostgreSQL lifecycle skips with temporary SQLite
  lifecycle tests; the final R0.4 gate is required to be fully PASS.
- SQLite serializes writes. R0.5 transaction scope must stay short and lock
  contention must be surfaced, never hidden by fabricated success.
- The current runtime layer still contains in-memory stores and a legacy
  PostgreSQL advisory-lock adapter. They are evidence to classify and replace,
  not authority to preserve automatically.
- The operator CLI still represents M44-era single-backend lifecycle behavior;
  R0.5 must reconcile it with the actual frontend/backend topology.
- The frontend middleware deprecation warning is non-blocking and should only
  be changed if required for the authorized lifecycle behavior.

## Stop rule

Stop after R0.5 acceptance evidence and one atomic commit. Do not roll into the
market-data/artifact unit or any later product work.
