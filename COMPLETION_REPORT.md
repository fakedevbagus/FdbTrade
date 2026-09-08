# Completion Report

Prompt ID: P01-04 — Implement authentication foundation
Phase: P1 Foundation
Date/time UTC: 2026-09-08T03:55Z
Branch/commit: main / implementation commit `d9aebd9` (report commit follows)

## What changed

Implemented private single-user authentication (library-backed via platform
primitives) with user/session/profile tables and a server-side authorization
guard. Recorded as **ADR-0008** (Private single-user authentication).

### Backend auth (`backend/src/auth/`, `backend/src/app/api/auth/`)

- `store.ts` (server-only): scrypt password hashing via node:crypto
  (N=16384, r=8, p=1, 64-byte key, random 16-byte salt; stored
  `scrypt$N$r$p$salt$hash`; constant-time verify). Zero new runtime
  dependencies. Sessions: 32-byte random opaque token (base64url), delivered
  only in an httpOnly `fdb_session` cookie (SameSite=Lax, Secure in
  production, Path=/, 7-day Max-Age); the DB stores only `sha256(token)` with
  timestamptz UTC `expires_at` — sessions survive server restarts and
  server-side logout is real. No password/hash/token is ever logged or
  returned (contract-tested: `store.ts` contains no console calls at all).
- `guard.ts`: `requireSession(request)` — the security boundary every
  private route calls. Missing cookie, unknown/expired token, inactive user,
  and database outage all produce the identical structured 401 (fail closed,
  no enumeration or outage oracle).
- Routes: `POST /api/auth/login` (zod-validated body; identical 401 for bad
  username/password; httpOnly Set-Cookie on success),
  `POST /api/auth/logout` (idempotent; DB delete + cookie clear),
  `GET /api/auth/session` (guarded session view — the guard's reference
  implementation). New `UNAUTHORIZED` (401) code added to the error taxonomy.
- `provision.mjs` (`db:provision-user`): the single user is provisioned by a
  CLI (password from `FDB_AUTH_BOOTSTRAP_PASSWORD` or stdin, never source,
  never echoed); there is deliberately NO registration endpoint (private
  single-user product).

### Migration `0002_auth_foundation`

- `fdb.users` (username unique, password_hash scrypt, `mfa_enabled` default
  false — reserved hook for a later MFA prompt, is_active),
  `fdb.sessions` (token_hash unique, user FK, created/expires/last_used,
  indexes), `fdb.user_profiles` (display_name, timezone 'UTC'). All
  ADR-0007 conventions; `.down.sql` reverses in dependency order.

### Frontend

- `src/middleware.ts` — **pre-render guard**: validates the session cookie
  against the backend before any rendering; unauthenticated `/dashboard`
  gets a 307 to `/login` with no content streamed (this closed a real leak
  found during verification: layout-level `redirect()` alone cannot stop
  already-streamed RSC content when a `loading.tsx` boundary exists).
- `(app)/layout.tsx` — server-side `fetchSession()` check + redirect as
  defense-in-depth; banner now shows the signed-in username + SignOutButton.
- `src/lib/auth.ts` — fail-closed session client (backend unreachable or
  malformed response ⇒ null; schema-validated response).
- `login/page.tsx` + `login-form.tsx` — accessible sign-in form (autocomplete
  attributes, error alert) posting to the same-origin proxy.
- `app/api/auth/[action]/route.ts` — same-origin BFF proxy forwarding
  login/logout/session to the backend (`FDB_BFF_URL`, default
  `http://127.0.0.1:3100`) and relaying the httpOnly Set-Cookie; only the
  three known auth actions are forwarded.
- `SignOutButton` + login-form styles; UI barrel export.

## Files changed

- Backend (new): `src/auth/store.ts`, `src/auth/guard.ts`, `src/auth/provision.mjs`,
  `src/auth/__tests__/store.test.ts`, `src/auth/__tests__/guard.test.ts`,
  `src/app/api/auth/{login,logout,session}/route.ts`,
  `src/app/api/auth/__tests__/routes.test.ts`,
  `db/migrations/0002_auth_foundation.sql`, `.down.sql`.
- Backend (modified): `src/http/errors.ts` (+UNAUTHORIZED), its test,
  `package.json` (+db:provision-user).
- Frontend (new): `src/middleware.ts`, `src/lib/auth.ts`,
  `src/app/login/{page.tsx,login-form.tsx}`,
  `src/app/login/__tests__/login-form.test.tsx`,
  `src/app/api/auth/[action]/route.ts`, `src/components/ui/SignOutButton.tsx`.
- Frontend (modified): `(app)/layout.tsx` (real guard + banner),
  `globals.css` (login/signout styles), `components/ui/index.ts`.
- Docs/tests: `docs/adr/ADR-0008-private-single-user-authentication.md`,
  `docs/adr/README.md` (index), `tests/test_ci_contracts.py` (KNOWN_ADRS 8),
  `tests/test_auth_foundation_contracts.py` (new; 18 tests),
  `tests/test_db_foundation_contracts.py` (migration list + rollback-most
  -recent), `tests/test_api_foundation_contracts.py` (exclude `__tests__`
  from the secret scan — documented dummy fixtures live there).

## Tests executed

- Backend vitest: `98 passed (98)` (crypto round-trips incl. malformed-hash
  rejection and salt uniqueness, token/cookie properties, guard fail-closed
  matrix, route 401/400/200/idempotency, no-secret-in-body assertions).
- Frontend vitest: `28 passed (28)` (LoginForm success/failure/unreachable,
  SignOutButton; router/fetch mocked).
- Backend/frontend `tsc --noEmit` + `eslint .` clean; both `next build`
  succeed (frontend now includes the Proxy/Middleware).
- Python contract tests: `tests.test_auth_foundation_contracts` — 18 OK
  (migration conventions, no-logging/no-literal static contracts, cookie
  contract, no-registration surface, frontend wiring incl. middleware, and
  the **live lifecycle**).
- **Live lifecycle** (real server + real DB): provision → guarded 401 →
  unknown-user vs wrong-password identical 401 → valid login 200 +
  httpOnly cookie → guarded 200 → **server restart → session still valid**
  → logout → cookie cleared → guarded 401 again; malformed body → 400.
- **Two-server live smoke** (frontend :3210 + backend :3100): unauthenticated
  `/dashboard` → 307 `/login`; login via same-origin proxy → 200 + cookie;
  authenticated `/dashboard` renders "Protected area — signed in as
  contract-owner" + Sign out; after logout `/dashboard` → 307 again.
- Root gate (clean environment): `make check` → `Ran 154 tests ... OK`,
  "All workspace checks passed."

## Acceptance criteria

- [x] Unauthenticated access is blocked from private routes — backend
      `requireSession` returns structured 401 (live-verified); frontend
      middleware redirects `/dashboard` → `/login` pre-render (no content
      leak — regression case documented above) + layout defense-in-depth.
- [x] Authenticated session survives restart — DB-backed sessions;
      live-verified by stopping and restarting the backend server mid-test.
- [x] Password/session data is not logged — no console output in the auth
      store (static contract), no secret in any response body or cookie debug
      (asserted in unit + live tests); hashes/tokens never appear in
      responses; provisioning CLI prints "value not shown".
- [x] Relevant tests pass from a clean environment — `make check` green
      (154 Python tests + all workspace packages); live tests self-skip with
      clear reasons when Docker/`.env` are absent.
- [x] Lint/typecheck/build clean for affected packages — backend and
      frontend gates pass.
- [x] No unrelated files modified without justification — changes limited to
      auth scope + the three contract updates it justifies (ADR list,
      migration inventory, secret-scan test fixtures).
- [x] Completion report written — this file.

## Known limitations / blockers

- No MFA yet by design: `mfa_enabled` is a reserved flag; the login flow has
  no challenge step. A later MFA prompt extends this (ADR-0008 item 8).
- Session expiry is fixed (7 days from creation), not sliding; `last_used_at`
  is refreshed for observability. Sliding expiry can be added later without
  schema changes.
- Frontend middleware guard covers `/dashboard` (the only protected route
  today); future protected routes must be added to `PROTECTED_PREFIXES` —
  the contract test documents this list.
- The frontend proxy forwards only `login|logout|session`; other private
  APIs will extend the proxy (or move behind it) in later prompts.
- scrypt parameters are fixed at N=16384; no rehash-on-login upgrade path
  yet (stored parameters make old hashes verifiable, so an upgrade prompt can
  migrate gradually).
- `make start` still runs one blocking server at a time (root runner runs
  packages sequentially); use the two package `start` scripts or the smoke
  pattern from this report for concurrent servers.

## Follow-up required before next prompt

None blocking. P1 phase gate ("Next.js + API + DB + auth/config + migrations")
is satisfied: web shell (P01-01), typed API (P01-02), PostgreSQL +
migrations (P01-03), and authentication (P01-04) all work locally with
passing gates.

## Risk notes

Security: passwords hashed with memory-hard scrypt (never stored/logged in
plaintext; constant-time verification); session tokens are opaque 256-bit
values whose sha256 hash is stored (DB leak does not expose usable tokens);
httpOnly cookie prevents JS access; SameSite=Lax mitigates CSRF on the
cookie-authenticated routes; no user enumeration or outage oracle (uniform
401); fail-closed guards everywhere (DB outage blocks access, never opens
it); single provisioning CLI keeps credential input out of source and logs;
no registration/multi-tenant surface exists (private product). The discovered
streaming leak (layout redirect alone insufficient under Suspense) was fixed
by pre-render middleware — protected content can no longer reach
unauthenticated responses.
Quant/trading safety: no strategy, signal, risk, or broker code was added;
live execution remains OFF by default (ADR-0005); auth gates only access,
never trading behavior; architecture boundaries (ADR-0003) intact — the
auth layer adds no execution path.

## Commit note

Two focused commits on `main`:
1. Implementation — hash recorded here: `d9aebd9`.
2. This completion report.

## Next prompt (safe to run)

`01_PROMPTS/P2_Data_Core/` — the P1 Foundation phase is complete; per
`00_CONTROL/RUN_ORDER.md`, the next phase gate is "P2: provider abstraction +
fixture feed + canonical bars/quotes + quality checks".
