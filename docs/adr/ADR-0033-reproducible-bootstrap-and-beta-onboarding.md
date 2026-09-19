# ADR-0033: Reproducible bootstrap and beta onboarding

- Status: Accepted
- Date: 2026-09-19
- Deciders: FdbTrade owner (approved M44 authorization in the post-Phase 2 blueprint pack)
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0002 (repository layout and workspace contracts), ADR-0004 (UTC time policy), ADR-0005 (live trading OFF by default), ADR-0028 (operational controls), ADR-0032 (advanced-alpha research layer)

## Context

M43 left the private beta usable only by someone who already knew the repository
internals. There was no reproducible install path, no dependency preflight, no
operator CLI, and no way to validate that a clean Linux checkout could reach a
ready dashboard. The post-Phase 2 blueprint authorizes exactly one milestone to
fix that: **M44 — Reproducible bootstrap and beta onboarding**.

Two constraints shaped the decision:

1. The blueprint words the dependency step as `npm ci`. This repository's
   approved dependency manager is pnpm (ADR-0001, ADR-0002) and it ships
   `pnpm-lock.yaml`, not `package-lock.json`. `npm ci` cannot reproduce an
   install here, and switching package managers would silently change the
   approved stack, which the core rules forbid.
2. The Python side of FdbTrade (`quant/`, `tests/`, `scripts/`) is deliberately
   stdlib-only. There are no third-party Python packages to pin, so
   `pip install -r requirements.txt` would abort with "You must give at least one
   requirement to install" unless the wrapper tolerates an installable-free file.

## Decision

1. **Deterministic Node install via pnpm.** The bootstrap uses
   `pnpm install --frozen-lockfile` and fails when `pnpm-lock.yaml` is missing or
   would change. This is the deterministic equivalent of `npm ci` and preserves
   the approved dependency manager. The substitution is recorded here rather than
   performed silently.
2. **Declared-but-empty Python requirement surface.** `requirements.txt` is kept
   as the single manifest of record for the Python dependency surface, documents
   the stdlib-only policy, and contains zero installable lines.
   `scripts/bootstrap.sh` and `scripts/fdbtrade init` detect an installable-free
   file and skip pip entirely instead of failing. Any future milestone that needs
   a third-party package must land its own ADR and add an exact `name==version`
   pin.
3. **Preflight reports, never assumes.** `scripts/fdbtrade preflight` reports
   Python, Node, npm, pnpm, Make, Bash, SQLite (CLI binary *and* Python stdlib
   driver), free disk, write permission, and loopback port availability for 3000,
   3100, and 15432. Missing tools are reported as errors or warnings, and the full
   documented key surface is always emitted so downstream gates and tests see
   stable keys. `--json` emits machine-readable output on stdout while all human
   diagnostics go to stderr.
4. **Bootstrap is safe, idempotent, and dry-runnable.** `scripts/bootstrap.sh`
   validates prerequisites before mutating anything, creates or validates `.venv`,
   installs only locked dependencies, creates `.env` from the committed template
   when missing, and never requests, generates, prints, or stores a secret.
   Re-running converges to the same state. `--dry-run` validates and prints the
   plan without mutating anything.
5. **Operator CLI.** `scripts/fdbtrade` exposes `preflight`, `init`, `start`,
   `stop`, `status`, `check`, and `recover`, with `init --dry-run` and
   `preflight --json`. `start` binds `127.0.0.1:3100` only. `stop` is deliberately
   scoped to the recorded state PID and the process actually listening on
   `127.0.0.1:3100`; it never matches unrelated Node/Next servers by name.
6. **Behavior-level gates, not file existence alone.** A new stdlib `unittest`
   suite executes the real CLI subcommands, parses `preflight --json`, asserts the
   required key surface and idempotency, runs the M44 make gates as subprocesses,
   and verifies loopback-only binding and unchanged safety flags.
7. **Authority files are committable.** `.gitignore` ignores `artifacts/*` but
   re-includes `artifacts/private-beta/`, because the acceptance evidence is a
   declared authority file and must be versioned.

## Consequences

- A clean Linux checkout reaches a validated, ready operator path with
  `make bootstrap` followed by `make preflight`, without manual import-path edits
  or undocumented packages.
- The deadlock between the blueprint's `npm ci` wording and the approved pnpm
  toolchain is resolved explicitly and is auditable.
- The Python dependency surface stays at zero third-party packages, which keeps
  the beta installable offline and removes a supply-chain surface.
- Preflight returns exit 1 only for hard errors (missing Node, Make, Bash, or an
  unusable Python `sqlite3` module). Environmental warnings such as a missing
  `sqlite3` CLI binary or an occupied port do not fail the gate but are always
  printed.
- SQLite is **not** integrated as the runtime store by this ADR. M44 reports
  SQLite availability only; runtime storage remains PostgreSQL via Docker until a
  later milestone plus its own ADR.
- Live execution stays OFF: `LIVE_EXECUTION_ENABLED=false` and
  `PROVIDER_ORDER_TRANSPORT_ENABLED=false` are asserted by the M44 gates and by
  the new test suite.

## Verification

```bash
make bootstrap                              # exit 0
make preflight                              # exit 0
python3 scripts/fdbtrade preflight --json   # exit 0, 11 documented keys
bash scripts/bootstrap.sh --dry-run         # exit 0, mutates nothing
bash scripts/bootstrap.sh --dry-run         # exit 0, identical output (idempotent)
bash scripts/bootstrap.sh --bogus           # exit 2 (unknown option rejected)
bash -n scripts/bootstrap.sh                # syntax valid
python3 -m py_compile scripts/fdbtrade      # syntax valid
python3 -m unittest tests.test_m44_bootstrap_contracts -v
make operational-packaging-check private-beta-check dashboard-check \
     security-check phase2-check handoff-check format-check
make test
```

Loopback-only binding and the two safety flags are asserted by the test suite, not
by assumption. If a criterion cannot be executed in the current environment, it is
reported as unverified rather than marked passed.