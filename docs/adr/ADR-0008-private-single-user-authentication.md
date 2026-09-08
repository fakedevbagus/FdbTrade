# ADR-0008: Private single-user authentication foundation

- Status: Accepted (P01-04)
- Date: 2026-09-08 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0003 (architecture boundaries),
  ADR-0004 (UTC time policy), ADR-0007 (database foundation), Prompt P01-04

## Context

P01-04 must implement private single-user authentication that can later
support MFA. FdbTrade is a private, single-user product (blueprint "Locked
decisions"): there is no public registration, no multi-tenancy, no
user-management surface. The prompt requires a managed or library-backed
approach; the environment already ships node:crypto (scrypt) and PostgreSQL
16 (ADR-0001), and the constitution forbids silently adding dependencies.

## Decision

1. **Library-backed via platform primitives, not a hosted auth service.**
   Password hashing uses node:crypto `scrypt` (N=16384, r=8, p=1, 64-byte key,
   random 16-byte salt per password, stored as `scrypt$N$r$p$salt$hash`).
   Verification is constant-time (`timingSafeEqual`). No new runtime
   dependency is introduced.
2. **DB-backed opaque sessions.** A session token is 32 random bytes
   (base64url), delivered only in an httpOnly `fdb_session` cookie
   (SameSite=Lax, Secure in production, Path=/, 7-day Max-Age). The database
   stores only `sha256(token)` with `expires_at` (timestamptz UTC), so sessions
   survive process restarts and server-side logout is real.
3. **Schema (migration 0002_auth_foundation).** `fdb.users` (username unique,
   password_hash, `mfa_enabled` default false as the reserved MFA hook,
   is_active), `fdb.sessions` (token_hash unique, user_id FK, created_at,
   expires_at, last_used_at; indexes on user_id and expires_at),
   `fdb.user_profiles` (display_name, timezone default 'UTC'). All ADR-0007
   conventions apply.
4. **Server-side guard is the security boundary.** `requireSession(request)`
   in `backend/src/auth/guard.ts` authenticates via the session cookie and
   throws a structured 401. Every private API route calls it. Frontend checks
   (`fetchSession` + redirect in the `(app)` layout) are UX convenience and
   fail closed (backend outage ⇒ redirect to /login).
5. **No enumeration or outage oracle.** Unknown user, wrong password,
   inactive user, and database-outage-during-auth all produce the identical
   structured 401. The health endpoint separately reports outages.
   Login failures never log the submitted password; hashes/tokens never
   appear in logs or responses (contract-tested).
6. **Provisioning is a CLI, not an endpoint.** The single user is provisioned
   by `backend/src/auth/provision.mjs` (`db:provision-user`), reading the
   password from `FDB_AUTH_BOOTSTRAP_PASSWORD` (or stdin), never from source.
   There is no registration API by design (private product).
7. **Frontend same-origin proxy.** The frontend `/api/auth/[action]` route
   forwards login/logout/session to the backend (`FDB_BFF_URL`, default
   `http://127.0.0.1:3100`) and relays the httpOnly Set-Cookie, so the
   browser only ever talks to one origin; credentials never enter the
   browser bundle as anything but transient form state.
8. **MFA path.** `mfa_enabled` is stored but gates nothing yet; a later MFA
   prompt extends the login flow (challenge step) and this ADR via a
   superseding or amending decision.

## Consequences

- Sessions are revocable server-side and survive restarts (DB-backed).
- Password hashing is CPU/memory-hard and standards-based without new deps;
   upgrading parameters means re-hashing on next successful login (stored
   parameters make old hashes still verifiable).
- Single user only: multi-user/multi-tenant work would need a superseding
   ADR (blueprint forbids public multi-tenant features in this phase anyway).
- The frontend must run with the backend reachable for sign-in; an
  unreachable backend fails closed to the login page.

## Verification

- Backend vitest: scrypt round-trips, malformed-hash rejection, token
  properties, cookie attributes, guard fail-closed, route 401/400/200 paths
  (all with mocked store — no live database needed).
- Python contract tests (`tests/test_auth_foundation_contracts.py`): schema
  conventions, secret-non-leakage static contracts, and — when the database
  is up — a live lifecycle (provision → login → guarded 200 → cookie →
  restart server → session still valid → logout → 401).
- `make check` passes.
