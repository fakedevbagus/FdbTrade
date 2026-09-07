# Completion Report

Prompt ID: P00-04 — Establish CI baseline and ADR system
Phase: P0 Constitution
Date/time UTC: 2026-09-07T17:26Z
Branch/commit: main / `c1f4bbb` (skeleton tracked), `b82aec8` (deliverables)

## What changed

Established the CI baseline and the ADR system for FdbTrade, reusing the
deterministic `make` gate (lint + typecheck + test + build) so local and CI
behaviour never diverge (ADR-0006).

### CI baseline

- `ci/run-local.sh` — deterministic local CI runner. Creates a clean-room copy
  of the source tree (excluding `.git`, `node_modules`, venvs, build caches, and
  **`.env`**), installs with `pnpm install --frozen-lockfile`, then runs the
  required jobs (`lint`, `typecheck`, `test`, `build`) via the root `make`
  targets with `set -e` fail-fast. Options: `--src`, `--work`, `--jobs`,
  `--skip-install`, `--help`. Deterministic; output timestamps are UTC; never
  reads or prints secrets. This is the executable CI baseline, runnable with no
  hosted service.
- `.github/workflows/ci.yml` — declarative CI (GitHub Actions) with four
  required, **blocking** jobs (`lint`, `typecheck`, `unit-tests`, `build`),
  triggered on pushes to `main` and pull requests. No job sets
  `continue-on-error`, so a failing required job blocks. Reuses `make lint`,
  `make typecheck`, `make test`, `make build`.

### ADR system

- `02_TEMPLATES/ADR_TEMPLATE.md` — ADR template (title, Status/Date/Deciders/
  Supersedes/Related metadata, Context/Decision/Consequences/Verification).
- `docs/adr/README.md` — documents the ADR format, sequential numbering from
  0001, the status lifecycle (Proposed/Accepted/Superseded/Deprecated), the
  process, verification, and an index of all ADRs.
- Four new ADRs (all `Status: Accepted`):
  - `ADR-0003-architecture-boundaries.md` — hard, unidirectional
    `strategy -> signal -> risk -> execution` boundary; LLM/AI has no order
    authority; typed contracts at boundaries.
  - `ADR-0004-utc-time-policy.md` — UTC is the single internal timezone; local
    conversion only at presentation; `app.timezone` locked to UTC.
  - `ADR-0005-live-trading-off-by-default.md` — live execution OFF by default;
    `broker.adapter` locked to `paper`; a config flag is not order authority.
  - `ADR-0006-ci-baseline.md` — one gate (`make check`), four required blocking
    jobs, local runner + GitHub Actions, determinism/no-secrets.

### Verification that CI "runs from a clean checkout"

- **True git clean checkout**: `git clone` of the repo at `b82aec8` into a
  fresh temp dir → `pnpm install --frozen-lockfile` → `make check` → **Exit 0**,
  `Ran 65 tests ... OK`, `All workspace checks passed.` (This required first
  tracking the previously-untracked workspace skeleton and control docs —
  commit `c1f4bbb` — so a clean checkout contains the full workspace.)
- `bash ci/run-local.sh` (clean-room copy of the working tree, with install)
  → **Exit 0**, all four jobs passed, 65 tests OK.
- Manual blocking demo: a failing `build` job → runner exits **1** with
  `[ci] FAILED: job 'build'`.
- `ci.yml` loads as valid YAML with exactly the jobs `lint, typecheck, test,
  build`, none with `continue-on-error`.

## Files changed

- `ci/run-local.sh` (new) — local deterministic CI runner.
- `.github/workflows/ci.yml` (new) — GitHub Actions, four required blocking jobs.
- `02_TEMPLATES/ADR_TEMPLATE.md` (new) — ADR template.
- `docs/adr/README.md` (new) — ADR format, numbering, lifecycle, process, index.
- `docs/adr/ADR-0003-architecture-boundaries.md` (new)
- `docs/adr/ADR-0004-utc-time-policy.md` (new)
- `docs/adr/ADR-0005-live-trading-off-by-default.md` (new)
- `docs/adr/ADR-0006-ci-baseline.md` (new)
- `tests/test_ci_contracts.py` (new) — 18 tests (ADR contract, workflow
  contract, runner contract).
- `tests/test_config_contracts.py` (modified) — added
  `test_timezone_is_locked_to_utc` to make ADR-0004's verification claim true.
- `docs/README.md` (modified) — ADR + CI pointers.
- `docs/adr/ADR-0001-baseline-stack.md` (modified) — Consequences now point to
  ADR-0002 for the recorded layout; it was an uncommitted working-tree edit
  from P00-02 that rode along in the prep commit (with a spacing typo that is
  corrected in the final commit of this prompt).
- `04_CLINE_CONTROL/CURRENT_STATE.md`, `04_CLINE_CONTROL/START_HERE.md`
  (modified) — advance verified/next-task pointers.
- `COMPLETION_REPORT.md` (this file, new).

## Tests executed

- `make check` (lint + typecheck + test + build for all packages + Python
  stdlib suite) → **Exit 0**, `Ran 65 tests ... OK`, `All workspace checks passed.`
- `bash ci/run-local.sh` (clean-room, real install) → Exit 0, all four jobs, 65
  tests OK.
- `python3 -m unittest discover -s tests -p 'test_*.py' -v` → 65 tests OK,
  covering:
  - valid input/expected output: runner happy path (all jobs), ADR files present
    with required sections, workflow contains four jobs + `make` targets.
  - malformed/missing input: runner unknown-option rejection; ADR numbering/
    section/template contract guards.
  - boundary/empty/stale: contiguous ADR numbering 0001..0006; `.env` excluded
    from clean-room copy; determinism/purity (runner does not mutate source).
  - idempotency: no events/jobs introduced; loader purity carried over from
    P00-03; runner is pure (does not mutate `--src`).
  - regression: secret-like `.env` never reaches CI workspace (newly exercised
    guarantee); timezone-lock regression test added for ADR-0004.

## Acceptance checklist

- [x] CI runs from a clean checkout — verified via a fresh `git clone` at
      `b82aec8` + `pnpm install --frozen-lockfile` + `make check`, Exit 0
      (65 tests OK); also via `ci/run-local.sh` clean-room copy, Exit 0.
- [x] CI blocks on failing required jobs — `ci.yml` has no
      `continue-on-error`/soft-fail; local runner `set -e` fail-fast, verified
      by a failing-`build` demo exiting 1. Unit-tested in
      `tests/test_ci_contracts.py`.
- [x] ADR format is documented — `docs/adr/README.md` + `02_TEMPLATES/ADR_TEMPLATE.md`,
      enforced by contract tests.
- [x] Lint/typecheck/build clean — `make check` Exit 0 (65 tests OK).
- [x] No unrelated files modified — only the files listed above. One scope note:
      commit `c1f4bbb` tracks the previously-untracked but pre-existing
      workspace skeleton and control/prompt/reference docs (`Makefile`,
      `package.json`, pnpm workspace files, `backend/`, `frontend/`,
      `contracts/`, `quant/`, `scripts/`, `00_CONTROL/`, `01_PROMPTS/`,
      `02_TEMPLATES/`, `03_REFERENCE/`, `.clinerules/`, etc.). This is a direct
      prerequisite of the "CI runs from a clean checkout" acceptance criterion;
      no file content was changed, only added to git.
- [x] Completion report written — this file.

## Blockers / limitations

- GitHub Actions cannot be observed from this offline host; the workflow is
  syntax-validated by tests (parsed YAML, job inventory) and mirrors the
  verified local runner. First push to GitHub will confirm the hosted path.
- Hosted CI pins `pnpm@9` and Python 3.12 via setup actions; exact minor
  versions follow ADR-0001.
- No deployment, no new dependencies.

## Security / quant implications

- CI clean-room copy excludes `.env` — secrets cannot leak into CI logs or
  artifacts (regression-tested).
- Runner output contains no env dumps; CI jobs never receive secret context.
- UTC-only policy (ADR-0004) and live-trading-off-by-default (ADR-0005) are now
  codified and regression-tested, protecting the quant-integrity and
  trading-safety boundaries before any strategy code exists.
- Architecture boundary ADR (ADR-0003) codifies strategy → signal → risk →
  execution as test-enforceable contract language for later phases.

## Commit note

Three focused commits on `main`:
- `c1f4bbb` — P00-04 (prep): track workspace skeleton, control docs, and prompt
  library so CI can run from a clean checkout.
- `b82aec8` — P00-04: CI baseline (local runner + GitHub Actions, four blocking
  jobs) and ADR system (template, format doc, ADR-0003..0006).
- Final commit: this completion report (see `git log --oneline` for the hash).

## Next prompt (safe to run)

`01_PROMPTS/P01_Foundation/P01-01_Build_web_application_shell.md`
