# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.2 — Capability audit**

Next authorized unit: **R0.3 — Reproducible toolchain**

## Resume context

1. Read `artifacts/rebuild/r0.2/capability-audit.json` and
   `docs/rebuild/checkpoints/R0.2_CAPABILITY_AUDIT.md`.
2. Keep the R0.2 classifications and safety findings as the current rebuild
   authority; legacy milestone/completion claims are evidence only.
3. Establish one deterministic, bounded install/lint/typecheck/test/build path.
4. Make Corepack/pnpm cache and store locations explicit and writable without
   depending on the operator's home directory.
5. Ensure every diagnostic records exit code, duration, timeout/skip state and
   first actionable failure; timeout, skip and environment-blocked are not PASS.
6. Make preflight return machine-readable failure JSON even when socket probes
   are forbidden by the environment.
7. Do not begin SQLite, runtime, product, UI, M48 or other repairs during R0.3.

## R0.3 environment blockers

- `pnpm --version` currently fails with `EROFS` while Corepack tries to create
  `/home/fakedevbagus/.cache/node/corepack/...`.
- Direct backend, frontend and contracts typechecks each exceeded the R0.2
  45-second diagnostic timeout without producing a diagnostic.
- Full backend, frontend, contracts and Python suites each exceeded the R0.2
  60-second timeout; their partial results are not full-suite passes.
- `scripts/fdbtrade preflight --json` currently raises `PermissionError` while
  creating an AF_INET socket in the sandbox and emits a traceback instead of
  JSON.
- Live PostgreSQL auth/database tests are skipped while the container is down;
  R0.3 must report that state honestly and must not start or migrate databases.
- Vitest reports that its TypeScript configs use ESM syntax while being loaded
  as CommonJS by the current config loader.

Safety invariants remain unchanged: live execution is off, provider-order
transport is off, fixture fallback may never impersonate current provider data,
and the quarantined M48 code is not authorized for runtime use. R0.3 is the only
authorized next unit.
