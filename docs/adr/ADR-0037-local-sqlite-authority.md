# ADR-0037: Local SQLite authority

- Status: Accepted
- Date: 2026-09-22
- Deciders: FdbTrade private-beta owner
- Supersedes: ADR-0007 database-engine and deployment decisions
- Related: ADR-0004, ADR-0008, ADR-0025, ADR-0033
- Work unit: R0.4

## Context

The selective rebuild targets one Linux-local, single-user decision-support
application. The inherited PostgreSQL/Redis/Docker topology added network
services, credentials and external mutable state without a product need. It
also made clean lifecycle validation depend on an operator-owned database.
Authentication sessions used PostgreSQL while privileged audit events existed
only in memory, so persistence had two conflicting authorities.

R0.4 must establish one local durable-state authority without touching the
unowned legacy PostgreSQL instance observed during R0.3. Node 24 provides the
required SQLite API in the pinned toolchain.

## Decision

1. Node 24 `node:sqlite` is the application database driver. The canonical
   database is `<data-root>/fdbtrade.sqlite3`; the data root defaults to
   repository-local `.fdbtrade` and an `FDB_DATA_ROOT` override must be an
   absolute path.
2. `backend/src/db/sqlite.mjs` is the shared connection, transaction and
   migration authority. Writable connections enable foreign keys, WAL,
   synchronous `FULL`, a bounded busy timeout, directory mode `0700`, and
   database mode `0600`.
3. Active migrations live only in `backend/db/sqlite-migrations`. They apply
   lexically, one immediate transaction per migration, with an atomic SHA-256
   ledger row. Applied checksum drift fails closed. Lifecycle tests always use
   temporary files or memory and require no Docker or external state.
4. The private user, password hash, profile and opaque-token sessions are
   stored in SQLite. A unique singleton key enforces one user. Reprovisioning
   rotates credentials without creating a second account; sessions survive a
   process restart.
5. Privileged audit events are stored in SQLite. Content validation and event
   identity remain in the contracts layer; database constraints and triggers
   reject duplicate, out-of-chronology, updated or deleted rows.
6. PostgreSQL, Redis and Compose are retired as active assumptions. The old
   PostgreSQL migration files remain in `backend/db/migrations` only as
   historical evidence and are not read by the active runner. The `pg`
   dependencies, network database configuration and Compose definition are
   removed.
7. There is no automatic import from the legacy PostgreSQL instance: its
   ownership/state is unresolved, old sessions should not be trusted across an
   authority reset, and the previous audit store was non-durable. The operator
   provisions the one SQLite user explicitly. No legacy service is inspected,
   mutated or cleaned up by R0.4.
8. Legacy PostgreSQL backup/restore commands fail closed. Designing and
   drilling SQLite backup/restore is deferred; scripts must not fabricate a
   successful backup or restore.

## Consequences

- A clean checkout can prove schema creation, idempotency, rollback, atomic
  failure, auth restart persistence and audit immutability hermetically.
- Local operation no longer requires Docker, a database port, a cache daemon
  or database credentials.
- SQLite serializes writes; short immediate transactions and a bounded busy
  timeout are mandatory. This is appropriate for the selected single-user
  workload, not a claim of multi-node scalability.
- Existing PostgreSQL data is not silently adopted or deleted. Any future
  import requires explicit ownership confirmation and a separate migration
  decision.
- Backup/restore remains an explicit gap and cannot report green until a later
  work unit implements and tests it.

## Verification

- Backend tests cover clean migrate, idempotent migrate, rollback/reapply,
  atomic failure, checksum drift, auth behavior, audit reopen persistence and
  update/delete rejection.
- `tests/test_db_foundation_contracts.py` runs the real migration CLI against a
  temporary data root and verifies schema ledger, integrity and permissions.
- `tests/test_auth_foundation_contracts.py` provisions a temporary database,
  starts the real backend, proves login/session persistence across restart,
  logs out, and requires no external service.
- `make toolchain-gate` is the final bounded acceptance gate.
