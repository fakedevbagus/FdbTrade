# @fdbtrade/frontend — Web frontend

Implemented from `01_PROMPTS/P01_Foundation/P01-01_Build_web_application_shell.md`.

Next.js (App Router) + React + TypeScript application shell:

- `src/app/` — routing: root layout (header/nav/footer), overview page,
  route-level `loading.tsx` / `error.tsx` / `not-found.tsx`.
- `src/app/(app)/` — protected app area **placeholder**; the authentication
  guard is implemented in P01-04.
- `src/components/ui/` — typed `Loading` / `EmptyState` / `ErrorState`
  primitives (server-safe, presentational only).
- `src/lib/site-config.ts` — zod-parsed site configuration; the schema
  enforces `liveExecutionEnabled: false` (presentation-level safety invariant
  per Blueprint v2 / ADR-0005).
- `src/app/globals.css` — design tokens, fixed typography scale, responsive
  grid, primitive styling (plain CSS, no runtime dependency).

## Commands

- `pnpm dev` — dev server
- `pnpm build` / `pnpm start` — production build / serve
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — gate commands used by
  `make check` (ESLint, `tsc --noEmit`, Vitest in jsdom)

## Conventions

- No trading logic, broker calls, or secrets in UI code (enforced by
  `tests/test_web_shell_contracts.py`).
- All internal timestamps are UTC (ADR-0004).
- Structural contracts are additionally tested from the repo root with
  Python stdlib tests (the CI convention), so no browser bundle is needed to
  verify the shell invariants.
