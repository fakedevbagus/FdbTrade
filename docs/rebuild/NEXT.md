# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.3 — Reproducible toolchain**

Next authorized unit: **R0.4 — Authority reset and SQLite foundation**

## Resume context

1. Read `artifacts/rebuild/r0.3/toolchain.json` and
   `docs/rebuild/checkpoints/R0.3_REPRODUCIBLE_TOOLCHAIN.md`.
2. Keep `scripts/rebuild_toolchain.py` and `make toolchain-gate` as the only
   install/lint/typecheck/test/build authority.
3. Define one canonical local data root and SQLite connection authority.
4. Add deterministic SQLite schema migrations, transaction boundaries, and
   clean-database lifecycle tests without Docker or external state.
5. Replace PostgreSQL auth/session authority and establish durable audit
   authority before broader runtime work.
6. Retire PostgreSQL/Redis/Docker assumptions only after parity evidence and a
   documented migration decision exist.
7. Do not begin application/runtime lifecycle, market-data authority, UI,
   credentialed provider, or M48 work during R0.4.

## R0.4 entry conditions and blockers

- The final R0.3 gate is intentionally non-PASS: its Python result reports two
  skipped legacy PostgreSQL lifecycle classes. Skip is not PASS.
- `FDB_TOOLCHAIN_EXTERNAL_STATE=disabled` must remain enforced; R0.4 must not
  make the gate depend on Docker or an operator database.
- An exploratory R0.3 diagnostic touched the already-running legacy PostgreSQL
  lifecycle before the guard was added. Read the incident record before any
  database action; do not attempt cleanup without resolving ownership/state.
- The sqlite3 CLI is absent, but Python sqlite3 3.45.1 and Node SQLite APIs are
  available. Select one explicit application authority and record the decision.
- Existing PostgreSQL migrations/auth/session code is evidence, not target
  authority. Replacement requires parity tests and a migration/retirement plan.
- Contracts ESLint and frontend middleware warnings remain non-blocking.

Safety invariants remain unchanged: live execution is off, provider-order
transport is off, fixture fallback may never impersonate current provider data,
and the quarantined M48 code is not authorized for runtime use. R0.4 is the only
authorized next unit.
