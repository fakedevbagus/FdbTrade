# Checkpoint 44 — Reproducible bootstrap and beta onboarding

- Milestone: M44
- Status: Complete — acceptance gates pass
- Target release: `2.0.0-private-beta`
- Recorded: 2026-09-19 (UTC)
- Baseline commit: `f284c2f42f69abc2cf4ffd69de7f6e036f33d626` (M43 state)

## 1. Objective

Make a clean Linux installation reproducible and make the private beta usable by
an operator who does not know the repository internals.

## 2. Delivered

| Artifact | Purpose |
| --- | --- |
| `scripts/bootstrap.sh` | Reproducible bootstrap: validates prerequisites, creates/validates `.venv`, installs locked deps, creates `.env` from template. `--dry-run` mutates nothing. |
| `scripts/fdbtrade` | Operator CLI: `preflight`, `init`, `start`, `stop`, `status`, `check`, `recover`, plus `preflight --json` and `init --dry-run`. |
| `requirements.txt` | Declared Python dependency surface (stdlib-only policy, zero third-party pins). |
| `Makefile` | `bootstrap`, `preflight`, and the seven M44 acceptance gates. |
| `tests/test_m44_bootstrap_contracts.py` | 35 behavior tests (real subprocess execution, clean-checkout, guard, safety). |
| `docs/OPERATOR_GUIDE.md` | Operator-facing install/config/run/monitor/recover guide. |
| `docs/adr/ADR-0033-*.md` | Decision record for the bootstrap, preflight, and CLI design. |
| `docs/checkpoints/43_private_beta.md` | The M43 checkpoint that was previously missing. |
| `.gitignore` | `artifacts/*` is ignored but `artifacts/private-beta/` is committable (acceptance evidence is an authority file). |

## 3. Required behavior → evidence

| Requirement | Evidence |
| --- | --- |
| Preflight reports Python, Node, npm, SQLite, Make, Bash, disk, permissions, ports | `scripts/fdbtrade preflight --json` emits all 11 documented keys; asserted by tests and by `make operational-packaging-check` |
| Safe bootstrap: `.venv`, locked deps, no secrets | `make bootstrap` exit 0; `--dry-run` exit 0 and mutates nothing; `grep` for prompting/secret generation fails |
| Deterministic locked install | `pnpm install --frozen-lockfile`; missing `pnpm-lock.yaml` fails closed (test) |
| `init`, `start`, `stop`, `status`, `check`, recovery guidance | All seven commands exposed; `init --dry-run` and `recover` exit 0 (tests) |
| Preserve loopback-only binding | `start` binds `127.0.0.1:3100`; `stop` is scoped to the state PID and the process listening on 3100, never a process-name match |
| Clean temporary checkout | Temp checkout (no `.venv`, no `.env`) dry-runs to a full plan without mutating (test) |
| Idempotent mutation | Repeated `--dry-run` produces identical output after timestamp stripping; asserted by the packaging gate and a test |
| Operator docs + handoff updated | `docs/OPERATOR_GUIDE.md` and `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md` |

## 4. Acceptance gates

```bash
make bootstrap                    # exit 0
make operational-packaging-check  # exit 0
make private-beta-check           # exit 0
make dashboard-check              # exit 0
make security-check               # exit 0
make phase2-check                 # exit 0
make handoff-check                # exit 0
```

Supporting gates: `make preflight`, `make format-check`, `make test`, `make lint`,
`make typecheck`, `make build`.

## 5. Safety state (unchanged)

- `LIVE_EXECUTION_ENABLED=false`
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false`
- Loopback-only binding (`127.0.0.1`)
- Paper-only broker; fixture mode remains the default regression path
- No live route, provider-order credential, public ingress, or automatic paper execution added

`make private-beta-check` scans production sources, configuration, and
documentation for an enabled live/transport flag and asserts the CLI reports
`false/false/loopbackOnly`. Test fixtures under `__tests__`/`*.test.ts` are
excluded from that scan **because they construct deliberately invalid payloads to
prove the guards reject them** — they are evidence for the invariant.
## 6. Known limitations (do not overstate)

1. **SQLite is not the runtime store.** M44 reports SQLite availability only
   (CLI binary plus Python stdlib driver). Runtime storage remains PostgreSQL via
   Docker until a later milestone lands an ADR for the change.
2. **`sqlite3` CLI binary absent on the development host.** Reported as a warning;
   the Python stdlib `sqlite3` module (3.45.1) is present and is what the Python
   side uses. The condition is never hidden.
3. **`pnpm install --frozen-lockfile` instead of `npm ci`.** The blueprint's wording
   conflicts with the approved dependency manager (ADR-0001/ADR-0002). The
   deterministic pnpm equivalent is used and the substitution is recorded in
   ADR-0033 rather than performed silently.
4. **No process lock / scheduler.** Continuous scheduling, process locking, cycle
   leases, and soak testing are M45, not M44.
5. **`make bootstrap` requires network access** only when the pnpm store is cold;
   with a warm store and matching lockfile it completes offline in under a second.
6. **Dashboard reachability was verified structurally, not by running a live
   server in this environment.** `make dashboard-check` asserts the dashboard and
   health routes exist and expose a GET handler, and that frontend pages exist.
   An end-to-end browser session is not claimed.

## 7. Next authorized milestone

**M45 — Continuous scheduler and runtime hardening.** Not started. Do not begin it
in the same agent run.

M45 (per the blueprint) owns: one process lock per runtime database, bounded
scheduler interval with an explicit clock source, cycle lease/heartbeat/timeout/
retry/shutdown states, recovery from interrupted cycles via durable checkpoints,
no duplicate cycle/job/outbox/order/fill, health projections, controlled
degradation, and bounded log retention.

## 8. Recovery pointer

1. Read `.clinerules/`.
2. Read `00_CONTROL/RUN_ORDER.md`.
3. Read `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`.
4. Read this checkpoint and `docs/checkpoints/43_private_beta.md`.
5. Inspect `git status` and the working tree.
6. Reconstruct the active prompt's acceptance criteria before changing files.

Operator recovery procedures: `RECOVERY.md` and `scripts/fdbtrade recover`.