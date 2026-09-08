# ADR-0007: SQL-first migrations and database foundation

- Status: Accepted (P01-03)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack: PostgreSQL 16), ADR-0002 (repository
  layout: `backend/`, `infra/`), ADR-0004 (UTC time policy), P00-03 config
  contract (`FDB_DB_*`), Prompt P01-03

## Context

P01-03 must add the database connection layer, migration tooling, and base
schema conventions. The blueprint locks PostgreSQL 16 (ADR-0001) but does not
prescribe a migration tool or ORM. The choice is durable: it shapes every
later schema-bearing prompt (P01-04 sessions, P02+ data core, P9 research).

## Decision

1. **SQL-first migrations, no ORM.** Each migration is a plain SQL file
   `NNNN_name.sql` under `backend/db/migrations/` (lowercase snake_case,
   4-digit zero-padded, lexically ordered). Optional `NNNN_name.down.sql`
   provides its rollback. Schema design and review happen in SQL, not in
   model classes.
2. **Deterministic runner, ledger-managed.** `backend/src/db/migrate.mjs`
   (stdlib + `pg` only) implements `migrate | rollback | status`. Applied
   migrations are recorded in `public.schema_migrations` (id, sha256
   checksum, applied_at_utc) — the ledger is created and owned by the runner,
   never part of a migration file. Re-running `migrate` is a no-op
   (idempotent); a checksum mismatch on an applied migration is a hard error
   (applied migrations are immutable on disk — fixes come as NEW migrations).
3. **Atomic application.** Each migration and its ledger row commit in one
   transaction; any failure rolls back the whole migration.
4. **Explicit, secret-free failures.** Connection/config failures exit
   non-zero with a clear message; driver messages (which can contain
   connection details) are reduced to stable codes. Credentials are read from
   `FDB_DB_*` environment variables (P00-03 names) and never printed.
5. **Base schema conventions** (established in migration
   `0001_foundation.sql`): application objects live under the `fdb` schema;
   `uuid` v4 primary keys via `gen_random_uuid()`; `timestamptz` with
   `DEFAULT now()` for all timestamps (stored UTC per ADR-0004); idempotency
   keys enforced by database constraints, never application code alone. No
   business tables in the foundation migration.
6. **Local bootstrap via isolated Compose.** `infra/compose.yaml` defines an
   isolated `fdbtrade` Compose project with `postgres:16`, no default
   credentials (missing `FDB_DB_*` fails loudly), a localhost-only published
   port (`FDB_DB_PORT`, default 15432 locally since 5432 is frequently
   occupied on developer machines), and a named volume. `scripts/db-bootstrap.sh`
   (and `make db-up`) create `.env` from the template with a random password
   when missing, wait for health, and migrate from zero.
7. **Rollback strategy.** Forward-only development posture with per-migration
   rollback support: `db:rollback` reverses the most recently applied
   migration using its `.down.sql` (missing file = explicit error). Applied
   migrations are never edited; destructive resets use
   `db-bootstrap.sh reset --yes` (volume deletion). Production restores use
   database backups, not down-migrations.
8. **Typed app-side access.** Application code uses the typed, server-only
   client `backend/src/db/client.ts` (pg Pool + sanitized health probe);
   `pg` is the only database dependency added.

## Consequences

- Every later schema change lands as a new, immutable, checksummed SQL file —
  reviewable diffs, no hidden model drift, no lock-in to an ORM's migration
  format.
- The runner is a deliberate exception to "only `src/env.ts` reads
  `process.env`": it is a standalone Node CLI, not part of the Next.js app or
  any browser bundle.
- Down-migrations are hand-written; complex migrations may opt to be
  forward-only by omitting the `.down.sql` (rollback then requires a new
  compensating migration or a backup restore).
- The local database lives in a Docker named volume (Docker-managed storage),
  avoiding NTFS bind-mount I/O for database files.

## Verification

- `make db-up` migrates a fresh database from zero (live, recorded in the
  P01-03 completion report and automated in
  `tests/test_db_foundation_contracts.py` when Docker is available).
- `db:migrate` twice applies once (idempotency test); `db:rollback` removes
  and re-apply restores (rollback test); wrong credentials fail with a
  non-zero exit and no secret in output (explicit-failure test).
- `make check` passes; ADR contract tests accept ADR-0007.
