# @fdbtrade/backend — BFF/API services

Typed API foundation for FdbTrade (implemented in
`01_PROMPTS/P01_Foundation/P01-02_Build_API_foundation.md`).

Stack (ADR-0001): Next.js (API-only, App Router route handlers) + TypeScript on
node 24 / pnpm. Validation uses zod (the same boundary-validation library the
frontend shell uses). Default port: **3100**.

## What lives here (P01-02 scope)

- `src/middleware.ts` — assigns/propagates `x-request-id` and
  `x-correlation-id` on every `/api/*` request (request and response).
- `src/http/` — the HTTP kernel:
  - `errors.ts` — `ApiError` taxonomy with stable machine codes and statuses.
  - `responses.ts` — structured JSON envelopes (`{ ok, data|error, requestId,
    timestamp }`), `cache-control: no-store`, UTC timestamps (ADR-0004).
  - `validate.ts` — content-type/size/JSON/zod request-body validation.
  - `handler.ts` — `withApi` wrapper: maps `ApiError` to structured 4xx and
    unknown failures to a generic structured 500 (message never leaked).
  - `request-context.ts` — request/correlation ID generation and validation.
- `src/env.ts` — zod-parsed server-side configuration. **Server-only** (see
  `src/server-only.ts`); the only app module that reads `process.env`
  (the standalone migration CLI is the one documented exception); contains
  no hardcoded database credentials; SQLite uses only `FDB_DATA_ROOT` and a
  bounded busy timeout.
- `src/db/client.ts` — typed, server-only SQLite connection authority using
  Node 24 `node:sqlite`, with a read-only health probe.
- `src/db/migrate.mjs` — deterministic SQL migration runner
  (`migrate | rollback | status`; ADR-0007): checksummed migrations in
  `db/sqlite-migrations/NNNN_name.sql`, ledger in `schema_migrations`,
  atomic per-migration transactions, immutable applied migrations.
- `src/app/api/health/route.ts` — `GET` health endpoint (liveness + identity
  + per-dependency `checks.database`; overall `status: ok | degraded`).
- `src/app/api/echo/route.ts` — `POST` validation contract fixture used by the
  test suite to prove malformed input returns structured 4xx. No business
  logic.
- `src/app/api/[...slug]/route.ts` — structured `NOT_FOUND` catch-all so every
  unmatched `/api/*` request is still traceable and machine-readable.

## Safety contracts

- No broker/strategy/execution code (hard boundary, ADR-0003).
- Live execution is never configurable here (ADR-0005).
- No secrets in source, logs, or responses; no `NEXT_PUBLIC_*` variables.
- All internal timestamps are UTC (ADR-0004).

## Database (R0.4)

SQLite is the only active durable-state authority. The default database is
`.fdbtrade/fdbtrade.sqlite3`; set `FDB_DATA_ROOT` to an absolute directory to
place it elsewhere. No Docker, PostgreSQL, Redis, database port, or database
credential is required.

```sh
make db-up        # compatibility alias: initialize/migrate SQLite
make db-migrate   # apply pending migrations
make db-status    # show applied/pending
make db-rollback  # roll back the most recent migration
make db-provision # provision or rotate the single local user
make db-down      # informational no-op; SQLite has no daemon
```

Migrations live in `db/sqlite-migrations/NNNN_name.sql` with optional
`NNNN_name.down.sql` rollback files. Conventions and the rollback strategy are
binding — see `docs/adr/ADR-0007-sql-migrations-and-database-foundation.md`:

- Applied migrations are immutable (checksum-verified); fixes come as NEW
  migrations.
- `db:rollback` reverses the most recent migration via its `.down.sql`
  (missing file = explicit error). No destructive reset command is exposed.
- UUIDs are application-generated and UTC instants are canonical ISO-8601
  text. Auth/session and audit data are durable; audit rows are protected by
  update/delete triggers.
- The old PostgreSQL SQL files remain only as inactive historical evidence.
  See ADR-0037.

## Commands

```sh
pnpm --filter @fdbtrade/backend dev    # dev server on :3100
pnpm --filter @fdbtrade/backend build  # production build
pnpm --filter @fdbtrade/backend start  # serve production build on :3100
pnpm --filter @fdbtrade/backend test   # vitest unit tests
```

Cross-cutting contract tests (including a live boot smoke test) live in
`tests/test_api_foundation_contracts.py`.
