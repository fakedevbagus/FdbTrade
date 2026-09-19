# Checkpoint 43 — Phase 2 private beta handoff

- Milestone: M43 (Phase 2 private-beta handoff)
- Status: Complete and accepted; M44 is the only authorized pending milestone
- Target release: `2.0.0-private-beta`
- Recorded: 2026-09-19 (UTC)
- Baseline commit: `f284c2f42f69abc2cf4ffd69de7f6e036f33d626` (`main`, P18/legacy roadmap complete)

## 1. Purpose

This is the durable checkpoint an operator or a fresh agent session reads before
doing any work in Phase 2. It states exactly what is certified, what is not, and
which milestone is authorized next. It must never claim more than the evidence
in `artifacts/private-beta/acceptance.json` supports.

## 2. Certified state at M43

- Legacy Milestones 00-29: complete and frozen. Do not rewrite them.
- Phase 2 Milestones 30-43: complete.
- `PHASE2_PROGRESS_MANIFEST.json`: `currentMilestone=43`, `nextPendingMilestone=44`.
- Runtime authority: fixture/offline, historical replay, mock/read-only shadow,
  and explicit operator-confirmed paper operations only.
- `LIVE_EXECUTION_ENABLED=false`.
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false`.

## 3. Product statement

FdbTrade at M43 is a usable **private Linux beta** for offline research,
historical replay, read-only market shadowing, and explicit paper trading within
the boundaries above.

It is explicitly **not**:

- a live-money trading system,
- a public SaaS product,
- a broker-connected execution system,
- a profitability or accuracy product.

No milestone may describe confidence as a guaranteed win probability, and no
artifact may claim guaranteed profit or guaranteed accuracy.

## 4. Authority files

| File | Role |
| --- | --- |
| `PHASE2_PROGRESS_MANIFEST.json` | Machine-checkable milestone ledger |
| `RECOVERY.md` | Recovery procedures and RTO/RPO expectations |
| `docs/checkpoints/43_private_beta.md` | This checkpoint |
| `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md` | Fresh-session resume protocol |
| `phase2/PHASE2_ACCEPTANCE_CRITERIA.md` | Per-milestone acceptance matrix |
| `phase2/PHASE2_ARCHITECTURE.md` | Phase 2 architecture overview |
| `phase2/PHASE2_RISK_REGISTER.md` | Live risk register with mitigations |
| `artifacts/private-beta/acceptance.json` | Machine-readable acceptance evidence |

## 5. Safety invariants (non-negotiable for every future milestone)

1. `LIVE_EXECUTION_ENABLED=false` in code, configuration, tests, reports, and the
   runtime environment.
2. `PROVIDER_ORDER_TRANSPORT_ENABLED=false` everywhere.
3. No live-money order or trade route.
4. No broker order credential, account secret, or secret pasted into chat.
5. Provider access, if ever introduced, is read-only market-data shadow only.
6. No hidden fallback from provider data to fixture-looking current data.
7. Missing, stale, inconsistent, unavailable, or unverified safety data fails
   closed.
8. `Strategy -> signal -> risk -> execution` is a hard boundary. Strategy code
   never calls a broker; risk hard limits are authoritative and cannot be
   bypassed by strategy or AI/LLM components.
9. LLM/AI may explain, rank, research, or propose. It never has direct
   broker-order authority.
10. Loopback-only binding (`127.0.0.1`). No public ingress.
## 6. Verification evidence recorded at M43

```text
python contracts : pass
typescript contracts : pass
aggregate : pass
live execution enabled : false
provider order transport enabled : false
loopback only : true
paper only : true
fixture default : true
```

Gates used: `make phase2-check`, `make handoff-check`, `make private-beta-check`,
plus the full `make test` regression suite.

## 7. Honest gaps carried into M44

These are limitations of the **M43** state, recorded so that M44 does not have to
rediscover them and so that no reader mistakes M43 for a finished installer:

- No `make bootstrap` reproducible install path.
- No `scripts/fdbtrade` operator CLI (`init`/`start`/`stop`/`status`/`check`/`recover`).
- No dependency preflight reporting Python, Node, npm, SQLite, Make, Bash, disk,
  permissions, and port availability.
- No `make preflight`, `operational-packaging-check`, `dashboard-check`,
  `security-check`, `format-check` gates.
- SQLite is **not yet** the runtime store; PostgreSQL runs via Docker.
- Operator documentation and the fresh-chat handoff are incomplete.

M44 owns exactly these gaps. Anything beyond them is out of scope for M44 and
belongs to M45+.

## 8. Next authorized milestone

**M44 — Reproducible bootstrap and beta onboarding** (`POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`).

M44 objective: make a clean Linux installation reproducible and make the private
beta usable by an operator who does not know the repository internals.

M44 acceptance gates:

```bash
make bootstrap
make operational-packaging-check
make private-beta-check
make dashboard-check
make security-check
make phase2-check
make handoff-check
```

Rule for the executing agent: run **only** M44, commit only M44 changes, and stop
before M45. Do not begin the next milestone in the same agent run.

## 9. Scope boundaries for M44

In scope: dependency preflight, safe bootstrap wrapper, operator CLI with
`init`/`start`/`stop`/`status`/`check`/recovery guidance, loopback-only
preservation, behavior-level tests, operator docs, ADR, checkpoint, handoff.

Out of scope for M44: continuous scheduler, process lock, soak testing
(M45); historical CSV import workflow (M46); seven-major coverage (M47);
credentialed provider shadow (M48); real-time paper hardening (M49); upgrade and
rollback distribution (M50); remote access (M51); research validity (M52);
live-execution feasibility (M53).

## 10. Recovery pointer

If state is lost or a session is interrupted:

1. Read `.clinerules/`.
2. Read `00_CONTROL/RUN_ORDER.md`.
3. Read `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`.
4. Read this checkpoint and the latest completion report.
5. Inspect `git status` and the working tree.
6. Reconstruct the active prompt's acceptance criteria before changing files.

Recovery procedures: `RECOVERY.md`. In-app guidance: `scripts/fdbtrade recover`.