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
  `src/server-only.ts`); contains no secrets; the only module allowed to read
  `process.env`.
- `src/app/api/health/route.ts` — `GET` health endpoint (liveness + identity).
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

## Commands

```sh
pnpm --filter @fdbtrade/backend dev    # dev server on :3100
pnpm --filter @fdbtrade/backend build  # production build
pnpm --filter @fdbtrade/backend start  # serve production build on :3100
pnpm --filter @fdbtrade/backend test   # vitest unit tests
```

Cross-cutting contract tests (including a live boot smoke test) live in
`tests/test_api_foundation_contracts.py`.
