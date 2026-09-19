# FdbTrade — Fresh Chat Resume Prompt (M43 → M44)

Use this prompt when starting a new agent session to resume work on FdbTrade.

## Repository State

- **Baseline milestone:** M43 (private-beta handoff complete and certified)
- **Current milestone:** M44 — Reproducible bootstrap and beta onboarding (**implemented, acceptance gates passing**)
- **Next authorized milestone:** M45 — Continuous scheduler and runtime hardening (**not started; do not begin in the same run**)
- **Git HEAD (M43 baseline):** `f284c2f` (P18 complete, legacy roadmap)
- **Branch:** `main`
- **Execution authority:** live execution OFF, provider order transport OFF, loopback-only, paper-only.

## Quick Context

FdbTrade is a private, single-user trading intelligence OS. The legacy P0-P18 roadmap is complete (mapped to Phase 2 M30-M43). The new post-Phase 2 blueprint (`POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`) defines milestones M44-M53.

**Critical invariants (never change):**
- `LIVE_EXECUTION_ENABLED=false` everywhere
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false` everywhere
- No live-money order/trade route
- No broker order credentials in source, logs, or chat
- Provider access = read-only market-data shadow only
- SQLite authoritative for private beta (PostgreSQL currently used via Docker)
- Strategy → signal → risk → execution is a hard boundary

## Resume Protocol

1. **Read the blueprint:** `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`
2. **Read authority files:**
   - `PHASE2_PROGRESS_MANIFEST.json`
   - `RECOVERY.md`
   - `docs/checkpoints/43_private_beta.md`
   - `phase2/PHASE2_ACCEPTANCE_CRITERIA.md`
   - `phase2/PHASE2_ARCHITECTURE.md`
   - `phase2/PHASE2_RISK_REGISTER.md`
   - `artifacts/private-beta/acceptance.json`
3. **Verify baseline:**
   ```bash
   git status --short --branch
   git rev-parse HEAD
   make phase2-check
   make handoff-check
   make private-beta-check
   ```
4. **Execute only M44** — do not begin M45.

## M44 Scope

Implement **only** Reproducible bootstrap and beta onboarding:

- Dependency preflight (Python, Node, npm, SQLite, Make, Bash, disk, permissions, ports)
- Safe bootstrap wrapper (`.venv`, locked Python deps, `npm ci`/`pnpm install --frozen-lockfile`, no secrets)
- Operator CLI: `scripts/fdbtrade` with `init`, `start`, `stop`, `status`, `check`, `recover`
- Loopback-only binding (127.0.0.1)
- Fixture/offline mode, paper-only authority
- Behavior tests, operator docs, checkpoint, ADR, changelog, recovery, inventory

## M44 delivered (verify, then trust)

- ✅ `scripts/fdbtrade` operator CLI (`preflight`, `init`, `start`, `stop`, `status`, `check`, `recover`, plus `preflight --json` and `init --dry-run`)
- ✅ `scripts/bootstrap.sh` reproducible bootstrap (`--dry-run`, idempotent, no secrets)
- ✅ `make bootstrap` and `make preflight`
- ✅ `make operational-packaging-check`, `private-beta-check`, `dashboard-check`, `security-check`, `phase2-check`, `handoff-check`, `format-check`
- ✅ `requirements.txt` declared (stdlib-only policy; zero third-party pins)
- ✅ `docs/OPERATOR_GUIDE.md`, `docs/checkpoints/43_private_beta.md`
- ✅ `docs/adr/ADR-0033-reproducible-bootstrap-and-beta-onboarding.md`
- ✅ `tests/test_m44_bootstrap_contracts.py` (35 behavior tests)
- ✅ `artifacts/private-beta/acceptance.json` is now committable (`.gitignore` re-includes `artifacts/private-beta/`)

Known M44 limitations (honest, do not paper over):

- SQLite is **not** the runtime store yet; PostgreSQL via Docker remains authoritative.
  `make preflight` reports SQLite availability only.
- `pnpm install --frozen-lockfile` is used where the blueprint says `npm ci`; recorded in
  ADR-0033 because this repository's approved dependency manager is pnpm.
- The `sqlite3` CLI binary is absent on this host; the Python stdlib module is used and
  the condition is reported as a warning, not an error.

## Environment Verification

```bash
python3 --version   # 3.12.3
node --version      # v24.19.0
pnpm --version      # 11.22.0
make --version      # GNU Make 4.3
bash --version      # 5.2.21
sqlite3 --version   # MISSING (install if needed)
docker --version    # 29.8.0
```

## Safety Checks

Before any edit:
- [ ] `LIVE_EXECUTION_ENABLED=false` in all configs
- [ ] `PROVIDER_ORDER_TRANSPORT_ENABLED=false` in all configs
- [ ] No secrets in source, fixtures, logs
- [ ] Loopback-only binding (127.0.0.1)
- [ ] Paper-only broker adapter

## After M44 Completion

M44 acceptance gates (run all of them; they must exit 0):

```bash
make bootstrap
make operational-packaging-check
make private-beta-check
make dashboard-check
make security-check
make phase2-check
make handoff-check
```

Then update:

- `PHASE2_PROGRESS_MANIFEST.json` → `currentMilestone=44`
- `artifacts/private-beta/acceptance.json` → M44 evidence
- `docs/checkpoints/44_bootstrap.md` (new checkpoint)
- this handoff file (point it at M45)

## Stop rule

Run **only** M44. Commit only M44 changes. Do **not** begin M45 (continuous
scheduler and runtime hardening) in the same agent run.

---

*Baseline generated at the M43 handoff; updated for the M44 implementation. Use
exactly as written for fresh chat resumption.*