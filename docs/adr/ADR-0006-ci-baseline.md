# ADR-0006: CI baseline

- Status: Accepted (P00-04)
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0002 (repository layout item 6),
  `Makefile` (`make check`), `ci/run-local.sh`, `.github/workflows/ci.yml`

## Context

ADR-0002 deferred the hosting/CI decision to P00-04. At P00-04 the repository has
no git remote and no CI runner. A CI baseline must exist that is runnable now,
blocks on failing required jobs, and reuses the established deterministic `make`
gate so later phases and CI never diverge.

## Decision

1. **One aggregate gate**: `make check` (lint + typecheck + test + build) is the
   single local and CI gate. CI invokes the same individual `make` targets so
   local and CI behavior are identical.
2. **Required, blocking jobs**: CI defines four required jobs corresponding to
   `make lint`, `make typecheck`, `make test`, `make build`. No job sets
   `continue-on-error`, so a failing required job fails the CI run (blocks).
3. **Local deterministic runner** (`ci/run-local.sh`): creates a clean-room copy
   of the source tree (excluding `.git`, `node_modules`, venvs, caches, `.env`)
   and runs the required jobs there with `set -e` fail-fast. It is the executable
   CI baseline and is runnable without any hosted service.
4. **Declarative CI** (`.github/workflows/ci.yml`): GitHub Actions workflow with
   the four required jobs, triggered on pushes to `main` and pull requests,
   reusing the `make` targets. GitHub Actions is the default provider definition
   because no remote host is decided; the binding host remains open until hosting
   is chosen (see P14-04) and this ADR may be superseded then.
5. **Determinism and no secrets**: CI is deterministic for deterministic inputs;
   timestamps in CI output are UTC; no job reads or prints secrets (`.env` is
   excluded and git-ignored).

## Consequences

- Anyone can run `ci/run-local.sh` from a clean copy and reproduce what a
  hosted runner will do.
- Introducing a hosted CI only requires pointing the provider at the repo and
  the same `make` targets; no gate logic drift.
- Because the P00-02 skeleton (`Makefile`, `package.json`, lockfile) is not yet
  committed, a hosted CI that checks out `HEAD` cannot run until those files are
  committed; the local runner copies the working tree and is therefore the
  verified baseline today. This blocker is tracked in the P00-04 completion
  report.

## Verification

- `tests/test_ci_contracts.py` enforces: runner `bash -n`, `--help`, unknown-job
  rejection, happy-path run, failing-job blocking (non-zero exit), source
  purity, and the workflow's four required blocking jobs.
- `ci/run-local.sh` (no args) passes in a clean-room copy in this phase.