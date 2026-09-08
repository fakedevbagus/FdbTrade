# Completion Report

Prompt ID: P01-03 — Initialize PostgreSQL and migrations
Phase: P1 Foundation
Date/time UTC: 2026-09-08T01:35Z
Branch/commit: main / implementation commit `2b78230` (report commit follows)

## What changed

Implemented the database foundation: connection layer, migration tooling,
base schema conventions, UTC/idempotency policy, and local bootstrap. Binding
conventions recorded as **ADR-0007** (SQL-first migrations and database
foundation).

### Connection layer (`backend/src/db/client.ts`)

- Server-only (guarded), lazy singleton `pg` Pool typed via `@/env` (new
  `FDB_DB_*` fields: host, port, name, user, password, pool size, ssl mode —
  same names as the P00-03 Python config contract).
- `checkDatabaseHealth`: dedicated one-off Client probe (isolated,
  configurable for tests), never throws, sanitizes failures to stable codes
  (ECONNREFUSED, 28P01, HEALTH_TIMEOUT) — connection strings/passwords never
  appear in results or logs.
- Typed `query` helper for later prompts; `DatabaseUnavailableError` for
  explicit fail-closed behavior.

### Migration runner (`backend/src/db/migrate.mjs`, `backend/db/migrations/`)

- Commands `migrate | rollback | status` (npm scripts `db:migrate`,
  `db:rollback`, `db:status`). SQL-first, no ORM; migrations are
  `NNNN_name.sql` with optional `NNNN_name.down.sql`.
- Runner-owned ledger `public.schema_migrations` (id, sha256 checksum,
  applied_at_utc timestamptz); migrations never touch it.
- Deterministic: lexical id order; re-run `migrate` is a no-op (idempotent);
  checksum mismatch on an applied migration is a hard error (immutable
  applied migrations — fixes come as NEW migrations).
- Atomic: each migration and its ledger row commit in one transaction.
- Explicit failures: non-zero exit, secret-free messages (driver messages
  reduced to codes). The CLI is the one documented exception to
  "only src/env.ts reads process.env" (standalone Node script, never bundled).

### Foundation migration `0001_foundation.sql`

- `fdb` schema + `fdb.system_settings` (key/value/jsonb, timestamptz). No
  business tables (per non-goal). Conventions in comments: snake_case, uuid
  v4 PKs via `gen_random_uuid()` (PG16 core), timestamptz UTC defaults
  (ADR-0004), idempotency via database constraints. `0001_foundation.down.sql`
  reverses it.

### Local bootstrap (`infra/compose.yaml`, `scripts/db-bootstrap.sh`)

- Isolated `fdbtrade` Compose project: `postgres:16`, localhost-only
  published port `FDB_DB_PORT` (default 15432 — host port 5432 is occupied by
  an unrelated local service and must not be touched), named volume, health
  check. No default credentials: missing `FDB_DB_*` fails loudly.
- `make db-up|db-down|db-migrate|db-status`. `db-up` creates `.env` from
  `infra/.env.example` with a random password if missing (never echoed),
  waits for health, migrates from zero. `reset --yes` is the only destructive
  path (volume deletion).
- `infra/.env.example` DB port updated to 15432 with the rationale documented.

### Health endpoint (P01-02 file, P01-03 behavior)

- `GET /api/health` now includes `checks.database` (`ok`/`unavailable`) and
  overall `status: ok | degraded`; HTTP stays 200; details stay sanitized.
  Unit tests updated with a mocked DB; live smoke asserts the consistency
  invariant (works in clean rooms without Docker).

### ADR-0007 + index

- `docs/adr/ADR-0007-sql-migrations-and-database-foundation.md` (Accepted);
  index row added; `tests/test_ci_contracts.py` KNOWN_ADRS updated.

## Files changed

- `backend/package.json` (+pg 8.23.0, +@types/pg 8.15.6, +db scripts),
  `backend/README.md` (database section).
- `backend/src/env.ts` (FDB_DB_* schema), `backend/src/db/client.ts` (new),
  `backend/src/db/migrate.mjs` (new).
- `backend/src/app/api/health/route.ts` (DB check),
  `backend/src/app/api/__tests__/routes.test.ts` (mocked DB tests).
- `backend/src/db/__tests__/client.test.ts`,
  `backend/src/db/__tests__/migrate.test.ts` (new; env parsing, sanitized
  errors, unreachable-DB health, runner planning logic + pinned sha256
  known-answer).
- `backend/db/migrations/0001_foundation.sql`, `0001_foundation.down.sql`
  (new).
- `infra/compose.yaml` (new), `infra/.env.example` (DB port),
  `scripts/db-bootstrap.sh` (new), `Makefile` (db targets + help).
- `docs/adr/ADR-0007-*.md` (new), `docs/adr/README.md` (index row).
- `tests/test_db_foundation_contracts.py` (new; 17 tests),
  `tests/test_api_foundation_contracts.py` (pg pin in EXPECTED_DEPS; health
  smoke consistency invariant), `tests/test_ci_contracts.py` (ADR-0007).
- `pnpm-lock.yaml`.

## Tests executed

- Backend vitest: `75 passed (75)` (incl. new db client + migrate runner tests).
- Backend `tsc --noEmit` clean, `eslint .` clean, `next build` succeeds.
- **Live database verification** (Docker `postgres:16` container
  `fdbtrade-postgres`, fresh volume): `make db-up` migrated from zero
  (`applied 0001_foundation`); second `migrate` → `applied=0 skipped=1`
  (idempotent); `db:status` lists applied/pending correctly; `db:rollback`
  → `rolled back 0001_foundation`, status pending; re-`migrate` → applied
  again. Verified in-database: schema `fdb` exists, `system_settings` empty,
  ledger row present, `now() AT TIME ZONE 'UTC' = now()` true.
- Live health: `/api/health` → `status: ok, checks.database: ok` with the DB
  up; `degraded` + `checks.database: unavailable` with the DB unreachable;
  wrong password never crashes or leaks.
- Wrong-credentials explicit failure: non-zero exit, "cannot connect to
  database" message, secret value absent from output (regression-tested).
- Python suite (clean FDB-free environment): `Ran 135 tests ... OK` —
  includes 17 new db-foundation contract tests and live lifecycle
  (migrate/idempotent/rollback/re-apply via the real CLI).
- Root gate: `make check` → "All workspace checks passed." (135 Python tests,
  all workspace lint/typecheck/test/build).

## Acceptance criteria

- [x] Fresh database can migrate from zero — `make db-up` on a fresh volume
      applied 0001 from zero (live-verified; automated in
      `test_full_lifecycle_migrate_idempotent_rollback_reapply`).
- [x] Rollback strategy is documented — ADR-0007 (down-migrations, forward
      -only posture, `reset --yes` for destructive resets, backups for
      production) + backend README + bootstrap help text.
- [x] Connection failures are explicit — sanitized codes, non-zero exits,
      `DatabaseUnavailableError`, degraded (never crashing) health;
      regression-tested for secret non-leakage.
- [x] Relevant tests pass from a clean environment — `make check` and the
      FDB-free Python run pass; live DB tests self-skip with a clear reason
      when Docker/`.env`/container are absent.
- [x] Lint/typecheck/build clean for affected packages — backend gates pass.
- [x] No unrelated files modified without justification — changes limited to
      the database foundation scope + the two contract updates it justifies.
- [x] Completion report written — this file.

## Known limitations / blockers

- Local host port 5432 is occupied by an unrelated service (left untouched);
  the fdbtrade postgres publishes on 15432. Documented in env template,
  env.ts comment, and compose.
- Rollback is single-step (most recent migration) by design; no batch
  down-migration. Complex future migrations may omit `.down.sql` (rollback
  then errors explicitly) per ADR-0007.
- Health check uses a fresh Client per request; pooling for the probe was
  deliberately avoided to keep probes isolated and deterministic. The app
  Pool singleton exists for real query traffic (later prompts).
- `pg` types (`@types/pg`) are dev-only; runtime `pg` is the single new
  dependency (pinned 8.23.0), permitted by ADR-0001's PostgreSQL decision and
  recorded in ADR-0007.

## Follow-up required before next prompt

None blocking. P01-04 (auth foundation) can create user/session/profile
tables as new migrations under the established conventions (fdb schema,
timestamptz UTC, uuid PKs) and reuse `@/db/client` + the structured API
kernel.

## Risk notes

Security: no credentials in source, compose, or logs (bootstrap generates
random dev passwords into the git-ignored `.env` only, "value not shown");
compose refuses to boot with missing `FDB_DB_*`; DB port bound to loopback
only; sanitized error codes only; `.env` excluded from CI clean-room copy.
Quant/trading safety: foundation-only schema, no business/trading data
structures; no strategy, signal, risk, or broker code added; live execution
remains OFF by default (ADR-0005); UTC timestamp policy enforced at the schema
level (ADR-0004).

## Commit note

Two focused commits on `main`:
1. Implementation — hash recorded here: `2b78230`.
2. This completion report.

## Next prompt (safe to run)

`01_PROMPTS/P01_Foundation/P01-04_Implement_authentication_foundation.md`
