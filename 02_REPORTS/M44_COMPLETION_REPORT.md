# M44 Completion Report — Reproducible bootstrap and beta onboarding

Prompt ID: M44 (post-Phase 2 blueprint, `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`)
Phase: Phase 2 — Operational Private Beta 2.1
Date/time UTC: 2026-09-19T09:20:00Z
Branch/commit: `main` (M44 implementation commit; authority pin follow-up)
Baseline commit: `f284c2f42f69abc2cf4ffd69de7f6e036f33d626`

## What changed

M44 makes a clean Linux installation reproducible and makes the private beta
usable by an operator who does not know the repository internals. Nothing about
trading authority changed: live execution stays OFF, provider order transport
stays OFF, binding stays loopback-only, broker stays paper-only.

### New operator surface

- `scripts/bootstrap.sh` — reproducible bootstrap. Validates prerequisites
  (`python3`, `pnpm`) *before* mutating anything, creates or validates `.venv`,
  installs only locked dependencies, and creates `.env` from the committed
  template when missing. `--dry-run` validates and prints the plan while mutating
  nothing; `--help` documents usage; unknown options exit 2. It never requests,
  generates, prints, or stores a secret. Re-running converges to the same state.
- `scripts/fdbtrade` — operator CLI with `preflight`, `init`, `start`, `stop`,
  `status`, `check`, and `recover`, plus `preflight --json` and `init --dry-run`.
  `start` binds `127.0.0.1:3100` only.
- `requirements.txt` — the declared Python dependency surface. The Python side is
  deliberately stdlib-only (verified: no third-party imports under `quant/`,
  `tests/`, or `scripts/`), so the file documents the policy and carries zero
  installable lines.

### Makefile gates (M44)

`bootstrap`, `preflight`, `operational-packaging-check`, `private-beta-check`,
`dashboard-check`, `security-check`, `phase2-check`, `handoff-check`,
`format-check`. These are behavior-level where it matters: the packaging gate
actually runs the bootstrap dry-run twice and diffs the output, runs the CLI,
parses `preflight --json` and asserts the required key surface, and runs real
`python3 -m py_compile`/`bash -n` checks.

### Documentation and records

- `docs/OPERATOR_GUIDE.md` (new) — operator install/configure/run/monitor/recover guide.
- `docs/checkpoints/43_private_beta.md` (new) — the missing M43 checkpoint.
- `docs/checkpoints/44_bootstrap.md` (new) — this milestone's checkpoint.
- `docs/adr/ADR-0033-reproducible-bootstrap-and-beta-onboarding.md` (new) plus
  `docs/adr/README.md` index row and `tests/test_ci_contracts.py` `KNOWN_ADRS`.
- `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md` — updated to point at M45.
- `PHASE2_PROGRESS_MANIFEST.json` — `currentMilestone=44`, `nextPendingMilestone=45`.
- `artifacts/private-beta/acceptance.json` — M44 evidence.
- `phase2/PHASE2_ACCEPTANCE_CRITERIA.md`, `PHASE2_ARCHITECTURE.md`,
  `PHASE2_RISK_REGISTER.md` — status refresh and honest risk states.
- `.gitignore` — `artifacts/*` stays ignored but `artifacts/private-beta/` is now
  committable, because the acceptance evidence is a declared authority file.

### Tests

`tests/test_m44_bootstrap_contracts.py` (new, 35 tests, stdlib `unittest`): the
bootstrap wrapper's syntax/help/unknown-option/dry-run/determinism/no-secret
behavior; a clean temporary checkout that dry-runs to a full plan without
## Files changed

- `scripts/bootstrap.sh` (new), `scripts/fdbtrade` (new), `requirements.txt` (new)
- `Makefile` (M44 targets + behavior-level gates + help)
- `tests/test_m44_bootstrap_contracts.py` (new, 35 tests)
- `tests/test_ci_contracts.py` (ADR-0033 registry entry)
- `.gitignore` (re-include `artifacts/private-beta/`)
- `docs/OPERATOR_GUIDE.md`, `docs/checkpoints/43_private_beta.md`,
  `docs/checkpoints/44_bootstrap.md` (new)
- `docs/adr/ADR-0033-reproducible-bootstrap-and-beta-onboarding.md`, `docs/adr/README.md`
- `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md`
- `PHASE2_PROGRESS_MANIFEST.json`, `artifacts/private-beta/acceptance.json`
- `phase2/PHASE2_ACCEPTANCE_CRITERIA.md`, `phase2/PHASE2_ARCHITECTURE.md`,
  `phase2/PHASE2_RISK_REGISTER.md`, `RECOVERY.md`, `COMPLETION_REPORT.md`

## Tests executed

- `make bootstrap` — exit 0; `.venv` created; `pnpm install --frozen-lockfile`
  reported "Already up to date" in 746 ms; `.env` left untouched.
- `make preflight` — exit 0 (warnings only: missing `sqlite3` CLI binary, port
  15432 in use by the PostgreSQL container).
- `make check` — exit 0; "All workspace checks passed."
  - Python: `Ran 511 tests ... OK`.
  - TypeScript: contracts 43 files / 631 tests, backend 68 files / 597 tests,
    frontend 12 files / 92 tests — all passed.
  - Total: 1831 tests (511 Python + 1320 TypeScript), all green.
- `make operational-packaging-check private-beta-check dashboard-check
  security-check phase2-check handoff-check format-check` — all exit 0.
- `python3 -m unittest tests.test_m44_bootstrap_contracts -v` — 35/35 OK.

## Acceptance criteria

- [x] Dependency preflight reports Python, Node, npm, SQLite, Make, Bash, disk,
      permissions, and port availability (11 documented keys, always present).
- [x] Safe bootstrap wrapper creates/validates `.venv`, installs only locked
      dependencies, and never requests secrets.
- [x] Clear `init`, `start`, `stop`, `status`, `check`, and recovery guidance.
- [x] Existing `scripts/fdbtrade` scope preserved with loopback-only binding.
- [x] Clean temporary checkout exercised (dry-run to full plan, mutating nothing).
- [x] Operator documentation and fresh-chat handoff updated after tests passed.
- [x] All seven blueprint acceptance gates pass.

## Known limitations / blockers

- SQLite is **not** the runtime store; M44 reports availability only and
  PostgreSQL via Docker remains authoritative.
- The `sqlite3` CLI binary is absent on this host; the Python stdlib module
  (3.45.1) is used and the condition is surfaced as a warning, never hidden.
- The blueprint says `npm ci`; this repository's approved dependency manager is
  pnpm, so `pnpm install --frozen-lockfile` is used and the substitution is
  recorded in ADR-0033 instead of being made silently.
- Dashboard reachability is verified structurally (routes expose `GET`, frontend
  pages exist). No end-to-end browser session is claimed.
- No process lock or continuous scheduler exists yet — that is M45.

## Follow-up required before next prompt

- None for M44. M45 is authorized and **not started**. Do not begin M45 in the
  same agent run.

## Risk notes

- Trading safety: no live route, no provider order credential, no public ingress,
  no automatic paper execution added. `make private-beta-check` asserts
  `false/false/loopbackOnly` from the CLI itself.
  Test fixtures under `__tests__`/`*.test.ts` are excluded from the enabled-flag
  scan because they construct deliberately invalid payloads to prove the guards
  reject them — they are evidence *for* the invariant, not against it.
- Quant integrity: no strategy, backtest, or research logic touched; no
  parameter optimization; no change to candle-close semantics or cost models.
- Security: no secrets introduced; `.env` remains ignored and untracked; the
  bootstrap only ever copies the committed placeholder template.
- Reproducibility: the locked install fails closed on lockfile drift, and the
  manifest, checkpoint, ADR, and acceptance evidence are all versioned.
mutating and fails closed when `pnpm-lock.yaml` is missing; the
installable-requirement guard via direct module import; every CLI command; pure
JSON on stdout with diagnostics on stderr; loopback-only binding; the safety
invariants; authority-file presence and honesty; and every M44 gate executed for
real as a subprocess.