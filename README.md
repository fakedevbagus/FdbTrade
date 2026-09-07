# FdbTrade — Private Trading Intelligence OS

FdbTradeis a private, single-user trading intelligence OS built from the approved
Blueprint v2.0 (see `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`). The repository is
a pnpm + Python monorepo skeleton (P00-02): placeholder areas for frontend,
backend/API, quant/research, shared contracts, scripts, tests, docs, and infra,
plus deterministic workspace entry points.

## Status

- Phase: P0 Constitution — repository skeleton and workspace contracts (P00-02 completed.
- Placeholder packages expose **no business logic**. Real implementation begins in P01 (Foundation.
- Live tradingis **OFF by default** and will remain so until explicit phase gates (P16/P17) are passed.

## Quickstart

Prerequisites (verified in `ENVIRONMENT.md`): node v24 + pnpm 11, Python 3.12,
GNU Make 4.3 (Docker needed from P01 / P00-03 onward.

```bash
make install        # pnpm install (no real deps on placeholders)
make lint           # lint all packages (no-op on placeholders)
make typecheck      # typecheck all packages (no-op on placeholders)
make test           # unit tests: pnpm workspace scripts + Python stdlib contracts tests
make build          # build all packages (no-op on placeholders)
make start          # start local dev servers (no-op on placeholders; P01+)
make check          # aggregate local gate: lint + typecheck + test + build
make help           # list targets
```

All entry points are deterministic (static output, no timestamps, deterministic for
deterministic inputs). All internal timestamps are UTC.

## Directory map

| Path | Area |
|---|---|
| `frontend/` | Next.js/React + TypeScript web UI (placeholder; P01-01+ |
| `backend/` | BFF/API services (TypeScript; placeholder; P01-02+ |
| `contracts/` | Shared typed contracts (`@fdbtrade/contracts`; placeholder; P02+ |
| `quant/` | Python quant engine/research (placeholder; P02+ |
| `scripts/` | Dev/ops helper scripts (conventions; see `scripts/README.md` |
| `tests/` | Cross-cutting stdlib contract tests (see `tests/README.md` |
| `docs/` | Docs + ADRs (see `docs/adr/`; `docs/README.md` |
| `infra/` | Docker/compose/env templates (placeholder; P00-03/P01-03; see `infra/README.md` |
| `00_CONTROL/` … `04_CLINE_CONTROL/` | Prompt pack control payload (reference; see `04_CLINE_CONTROL/START_HERE.md` |

## Workspace contracts (short form

Full rules: `.clinerules/`, `00_CONTROL/AGENT_CONSTITUTION.md`, `CONTRIBUTING.md`.

- All internal timestamps are UTC.
- Deterministic behaviorfor deterministic inputs.
- Typed contractsand schema validation at boundaries.
- Never put secrets in source, fixtures, logs or browser bundles.
- No broker calls from strategy, feature, UI or LLM code; live execution OFF by default.
- Use mocks/fixtures when external credentials are unavailable.
- Every production bug gets a regression test.

## Links

- `ENVIRONMENT.md` — verified runtime facts (P00-01.
- `docs/adr/ADR-0001-baseline-stack.md` — baseline stack decision.
- `docs/adr/ADR-0002-repository-layout-and-workspace-contracts.md` — this layout decision.
- `03_REFERENCE/BLUEPRINT_V2_FROZEN.md` — frozen blueprint (source of truth.
- `04_CLINE_CONTROL/START_HERE.md` — execution protocol handoff.
