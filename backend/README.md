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
  no hardcoded secrets — credentials arrive at runtime via `FDB_DB_*`.
- `src/db/client.ts` — typed, server-only PostgreSQL connection layer
  (`pg` Pool singleton, sanitized health probe, typed `query` helper).
  Connection failures are explicit and reduced to stable codes; raw driver
  messages (which can contain connection details) are never surfaced.
- `src/db/migrate.mjs` — deterministic SQL migration runner
  (`migrate | rollback | status`; ADR-0007): checksummed migrations in
  `db/migrations/NNNN_name.sql`, ledger in `public.schema_migrations`,
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

## Database (P01-03)

PostgreSQL 16 via the isolated `fdbtrade` Docker Compose project
(`infra/compose.yaml`; port `FDB_DB_PORT`, default 15432 on this host because
5432 is occupied by unrelated local services).

```sh
make db-up        # start postgres + migrate from zero (creates .env if missing)
make db-migrate   # apply pending migrations
make db-status    # show applied/pending
make db-down      # stop postgres (data volume preserved)
```

Migrations live in `db/migrations/NNNN_name.sql` with optional
`NNNN_name.down.sql` rollback files. Conventions and the rollback strategy are
binding — see `docs/adr/ADR-0007-sql-migrations-and-database-foundation.md`:

- Applied migrations are immutable (checksum-verified); fixes come as NEW
  migrations.
- `db:rollback` reverses the most recent migration via its `.down.sql`
  (missing file = explicit error); destructive resets use
  `scripts/db-bootstrap.sh reset --yes` (volume deletion). Production
  recovery uses backups, not down-migrations.
- Application objects live under the `fdb` schema; uuid v4 PKs; timestamptz
  UTC (ADR-0004); idempotency enforced by constraints.

## Commands

```sh
pnpm --filter @fdbtrade/backend dev    # dev server on :3100
pnpm --filter @fdbtrade/backend build  # production build
pnpm --filter @fdbtrade/backend start  # serve production build on :3100
pnpm --filter @fdbtrade/backend test   # vitest unit tests
```

Cross-cutting contract tests (including a live boot smoke test) live in
`tests/test_api_foundation_contracts.py`.
