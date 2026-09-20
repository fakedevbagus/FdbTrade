# FdbTrade — Fresh Chat Resume Prompt (M46 → M47)

Use this prompt when starting a new agent session to resume work on FdbTrade.

## Repository State

- **Baseline milestone:** M43 (private-beta handoff complete and certified)
- **Current milestone:** M46 — User-facing historical research workflow (**complete, acceptance evidence recorded**)
- **Next authorized milestone:** M47 — Seven-major runtime coverage (**not started; do not begin in the same run**)
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
4. **Execute only M47** — do not begin M48.

## M45 delivered (verified, all gates pass)

- ✅ `backend/src/runtime/clock.ts` — explicit `ClockSource`, `SystemClock`, `ManualClock` (deterministic, UTC)
- ✅ `backend/src/runtime/lock.ts` — one process lock per runtime database, heartbeat, takeover of stale locks
- ✅ `backend/src/runtime/lease.ts` — cycle lease state machine (pending→leased→running→committing→completed), timeout/retry/shutdown
- ✅ `backend/src/runtime/dedupe.ts` — universal deduplication across 5 domains (cycle, job, outbox, paper_order, fill)
- ✅ `backend/src/runtime/checkpoints.ts` — hash-chained durable checkpoints, completion ledger (first-write-wins)
- ✅ `backend/src/runtime/degradation.ts` — controlled degradation (queue, memory, disk, staleness → 4 levels)
- ✅ `backend/src/runtime/health.ts` — pure health projection across 6 subsystems
- ✅ `backend/src/runtime/retention.ts` — bounded cycle-correlated ring log
- ✅ `backend/src/runtime/scheduler.ts` — continuous scheduler engine with tick loop
- ✅ `backend/src/runtime/observation.ts` — observation-only stage handlers, zero order authority
- ✅ `backend/src/runtime/startup.ts` — disabled by default, opt-in via `FDB_CONTINUOUS_SCHEDULER_ENABLED=true`
- ✅ `backend/src/runtime/soak.ts` — fixture soak harness with crash recovery convergence
- ✅ `backend/src/runtime/__tests__/runtime.test.ts` — 56 Vitest tests
- ✅ `tests/test_m45_runtime_contracts.py` — 10 Python contract tests
- ✅ `make runtime-check`, `operational-persistence-check`, `integration-replay-check` added to Makefile
- ✅ `docs/adr/ADR-0034-continuous-scheduler-and-runtime-hardening.md`
- ✅ `docs/checkpoints/45_continuous_scheduler.md`

### M44 also verified (prior milestone)

- ✅ `scripts/fdbtrade` operator CLI, `scripts/bootstrap.sh`, `requirements.txt`
- ✅ `make bootstrap`, `make preflight`, all M44 gates exit 0
- ✅ `docs/adr/ADR-0033-reproducible-bootstrap-and-beta-onboarding.md`
- ✅ `tests/test_m44_bootstrap_contracts.py` (35 tests)

Known limitations (honest, do not paper over):

- SQLite is **not** the runtime store yet; PostgreSQL via Docker remains authoritative.
- `pnpm install --frozen-lockfile` used where blueprint says `npm ci` (ADR-0033).
- The `sqlite3` CLI binary is absent; Python stdlib module works; warning only.
- Frontend vitest fork workers occasionally time out on NTFS/fuseblk filesystem (all 44 tests pass; error is worker spawn timing, pre-existing).

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
- [ ] Continuous scheduler disabled by default

## M46 delivered

- Authenticated preview/confirmation/list/replay routes for immutable user-owned CSV datasets.
- `/research/datasets` operator page and navigation entry; historical mode is explicit.
- Fail-closed CSV validation for malformed, ambiguous, duplicate, gapped, quarantined, and oversized input.
- Historical backtest dataset checksum provenance and reproducible run identity.
- `make historical-research-check` covers import, reopen, replay, divergence, oversize rejection, and provenance.

## M46 acceptance evidence

M46 gates completed before authority pin:

```bash
make runtime-check
make operational-persistence-check
make operational-packaging-check
make integration-replay-check
make private-beta-check
make dashboard-check
make security-check
make phase2-check
make handoff-check
```

Authority pinned:

- `PHASE2_PROGRESS_MANIFEST.json` has `currentMilestone=46` and `nextPendingMilestone=47`.
- `docs/checkpoints/46_historical_research.md` records M46 behavior and recovery.
- This handoff points to M47.

## Stop rule

Run **only** M47. Commit only M47 changes. Do **not** begin M48 (credentialed read-only provider shadow) in the same agent run.

---

*Updated at M46 completion. Use exactly as written for fresh chat resumption.*