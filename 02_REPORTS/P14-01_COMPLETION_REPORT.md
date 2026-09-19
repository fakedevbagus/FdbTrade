# Completion Report

Prompt ID: P14-01 Security hardening
Phase: P14 Hardening
Date/time UTC: 2026-09-12T04:40:00Z
Branch/commit: main / c001db9 + P10–P14 working tree (uncommitted)

## What changed
- API Middleware security hardening in `backend/src/middleware.ts`:
  - Enforced security headers: CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, etc.), HSTS (`max-age=31536000`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
  - Client token-bucket rate limiting (20 tokens bucket size, 10/s refill, returning 429 RATE_LIMITED).
  - Replay attack protection with memory-bounded seen request ID store (window of 60s, max 10k items, returning 409 REPLAY_DETECTED).
- API error taxonomy extension in `backend/src/http/errors.ts`:
  - Added `RATE_LIMITED` (429) and `REPLAY_DETECTED` (409) with static factory helpers and test coverage.

## Files changed
- `backend/src/middleware.ts`
- `backend/src/http/errors.ts`
- `backend/src/http/__tests__/errors.test.ts`

## Tests executed
- `pnpm --filter @fdbtrade/backend run test` (67 test files / 597 tests green).
- `pnpm run check` (typecheck, lint, test, build all pass).
- `python3 -m unittest discover -s tests -p 'test_*.py' -v` (476/476 tests green).

## Acceptance criteria
- [x] No critical secret leakage or privilege escalation in test suite.
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified.
- [x] Completion report written.

## Known limitations / blockers
- Replay protection memory store is in-process (suitable for single-node development; scalable to Redis for multi-node deployments).

## Follow-up required before next prompt
- Proceed to P14-02 (Performance/load hardening).

## Risk notes
- Security: All API routes protected by default against replay attacks and request flooding; all sensitive security headers enabled; live execution remains OFF.
