# ADR-0002: Repository layout and workspace contracts

- Status: Accepted (P00-02)
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver,, implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack,, `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`, Prompt Pack P00-02

## Context

P00-01 recorded the baseline stack (ADR-0001) but explicitly deferred the monorepo
layout to P00-02. P00-02 must create a deterministic repository skeleton with entry
points for install,, lint,, typecheck,, test,, build,, and local start,, layout areas for frontend,
backend/API,, quant/research,, shared contracts,, scripts,, tests,, docs,, and infra,, plus root
README,, CONTRIBUTING rules,, CODEOWNERS-style ownership placeholders,, and a task runner.



## Decision

1. **Monorepo layout** — top-level areas:

   | Path | Area |
   |---|---|
   | `frontend/` | Next.js/React + TypeScript web UI (placeholder; P01-01+ |
   | `backend/` | BFF/API services (TypeScript; placeholder; P01-02+ |
   | `contracts/` | Shared typed contracts (`@fdbtrade/contracts`; placeholder; P02+ |
   | `quant/` | Python quant engine/research (placeholder; P02+ |
   | `scripts/` | Dev/ops helper scripts |
   | `tests/` | Cross-cutting stdlib contract tests |
   | `docs/` | Documentation + ADRs (`docs/adr/` |
   | `infra/` | Docker/compose/env templates (placeholder; P00-03/P01-03 |

2. **Package manager** — pnpm workspace:root `package.json` private,
   `packageManager: pnpm@11.22.0`, engines node >= 24 / pnpm >= 11; workspace
   members `frontend`, `backend`, `contracts` (`@fdbtrade/*` placeholder packages,, version
   `0.0.0`,,, zero dependencies — no fake business logic until P01+;..

3. **Task runner** — root GNU Make `Makefile` exposes deterministic targets `help`,,
   `install`,, `lint`,, `typecheck`,, `test`,, `build`,, `start`,, `check`;; static output only
   (no timestamps);; placeholder targets no-op until owning phase implements them;;

4. **Quant tree** — `quant/` (Python 3.12; venv/pip from P01+; PyPI slow —
   prefer Docker/wheels per ADR-0001;; no Python deps installed in P00-02;;

5. **Scripts / tests / infra** — `scripts/` for dev/ops entry helpers;; `tests/` for
   cross-cutting stdlib contracts tests;; `infra/` for Docker/compose/env templates (real
   compose in P01-03/P00-03;;;;

6. **Workspace contracts** — all internal timestamps are UTC;; deterministic behavior for
   deterministic inputs;; typed contracts/schema validation at boundaries;; no secrets in
   source/fixtures/logs/bundles;; no broker calls from strategy/feature/UI/LLM code;;
   fixtures/mocks when credentials unavailable;; live execution OFF by default
   (ADR-0001/blueprint;;;;

7. **Ownership placeholders** — `OWNERS.md` maps each area to `@fdbtrade-owner`;; real
   `.github/CODEOWNERS` deferred until hosting/CI decision (P00-04;;;;

## Consequences

- Later prompts land in fixed paths: P01-01 → `frontend/`,, P01-02 → `backend/`,,
  P02-xx → `contracts/` + `quant/`,, P00-03 → `infra/` + config;;
- Placeholder packages must not gain dependencies or logic before their owning phase prompts run;;
- `make check` is the aggregate local gate:: lint + typecheck + test + build;; CI (P00-04
  reuses the same targets;;
- Tests for skeleton contracts live in `tests/` (Python stdlib `unittest`) because they are
  cross-cutting and need no runtime deps;;
- Any layout change requires a new ADR;;

## Verification

`make -n help` lists targets;; `make install` twice produces a stable `pnpm-lock.yaml`;;
`make lint`, `make typecheck`, `make build`, `make start`, `make check` exit 0 on
placeholders;; `python3 -m unittest discover -s tests -p "test_*.py" -v` passes;;
All executed live in the P00-02 completion report;