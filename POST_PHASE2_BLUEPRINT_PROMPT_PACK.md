# FdbTrade Post-Phase 2 Blueprint and Staged Prompt Pack

Version: 1.0.0  
Status: Planning only — no post-Phase 2 milestone is authorized yet  
Prepared: 2026-09-11  
Baseline: Phase 2 Milestone 43 private-beta handoff

> This is the single source file for the next project plan and the staged
> prompts intended for an agentic coding workflow. Execute one prompt at a time.
> Do not let an agent continue automatically to the next prompt.

---

## 1. Current authority

The certified repository state is:

- Legacy Milestones 00–29: complete and frozen.
- Phase 2 Milestones 30–43: complete.
- `currentMilestone=43`.
- `nextPendingMilestone=null`.
- Target release: `2.0.0-private-beta`.
- Runtime authority: fixture/offline, historical, mock/read-only shadow, and
  explicit paper operations.
- `LIVE_EXECUTION_ENABLED=false`.
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false`.
- No live route, provider order credential, public ingress, or automatic paper
  execution may be added by this plan.

The current product is a usable private Linux beta inside those boundaries. It
is not a live-money trading system, public SaaS, broker-connected execution
system, or profitability product.

The current authoritative references are:

- `PHASE2_PROGRESS_MANIFEST.json`
- `RECOVERY.md`
- `docs/checkpoints/43_private_beta.md`
- `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md`
- `phase2/PHASE2_ACCEPTANCE_CRITERIA.md`
- `phase2/PHASE2_ARCHITECTURE.md`
- `phase2/PHASE2_RISK_REGISTER.md`
- `artifacts/private-beta/acceptance.json`

The legacy manifest remains frozen. Do not rewrite Milestones 00–29.

---

## 2. Product objective after M43

The next product objective is **Operational Private Beta 2.1**:

> A single Linux user can install, configure, run, monitor, recover, and use
> FdbTrade for offline research, historical replay, read-only market shadowing,
> and explicit paper trading without reading source code or manually repairing
> state.

The objective is not to turn on live trading. The product must first become
boringly reliable as a local decision-support and paper-trading application.

### Normal operation definition

A normal user must be able to:

1. Install the exact supported dependencies.
2. Initialize a local SQLite runtime.
3. Start and stop the application safely.
4. See database, data-source, analysis, queue, and paper-broker health.
5. Replay fixture data or import a user-owned historical dataset.
6. Inspect provenance, freshness, evidence, risk, and uncertainty.
7. Run a backtest with an immutable dataset and reproducible report.
8. Explicitly review and confirm a paper operation.
9. Inspect portfolio, orders, fills, alerts, calendar risk, and journal state.
10. Restart the application and see the same authoritative durable state.
11. Back up, restore, reconcile, and recover without inventing progress.
12. Understand clearly what is unavailable, stale, degraded, simulated, or
    provider-gated.

---

## 3. Non-negotiable rules for every future milestone

Every future agent must preserve these rules:

- `LIVE_EXECUTION_ENABLED=false` in code, configuration, tests, reports, and
  runtime environment.
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false` everywhere.
- No live-money order or trade route.
- No broker order credential, account secret, or secret pasted into chat.
- Provider access, if introduced, is read-only market-data shadow only.
- No hidden fallback from provider data to fixture-looking current data.
- No LLM output may create, approve, size, route, or send an order.
- Missing, stale, inconsistent, unavailable, or unverified safety data fails
  closed.
- SQLite remains the authoritative private-beta store until measured evidence
  and a separate ADR justify another database.
- Existing domain services are wrapped rather than rewritten.
- Offline fixture replay remains mandatory regression infrastructure.
- Every milestone must include behavior-level evidence, not static file checks
  alone.
- Every mutation must be idempotent or fail on divergent reuse.
- Every milestone must survive restart or explicitly document why it has no
  durable state.
- Every milestone gets its own implementation commit and verification result.
- Do not begin the next milestone in the same agent run.

---

## 4. Roadmap and dependency order

| Milestone | Name | Depends on | Primary outcome |
| --- | --- | --- | --- |
| M44 | Reproducible bootstrap and beta onboarding | M43 | New user can install and start the beta predictably |
| M45 | Continuous scheduler and runtime hardening | M44 | App can run continuously and recover safely |
| M46 | User-facing historical research workflow | M45 | Historical import, replay, and research are easy to operate |
| M47 | Seven-major runtime coverage | M46 | Seven configured major pairs run with isolation and provenance |
| M48 | Credentialed read-only provider shadow | M47 | Optional real market observation without order authority |
| M49 | Real-time paper operations hardening | M48 | Durable paper workflow is usable for ongoing simulation |
| M50 | Upgrade, rollback, and operational distribution | M49 | Private Linux installation is maintainable across versions |
| M51 | Private remote access and security | M50 | Optional authenticated private access without public exposure |
| M52 | Research validity and strategy evidence | M46, M47 | Research results are statistically and operationally honest |
| M53 | Live-execution feasibility review | M48, M49, M50, M51, M52 | Decision package only; does not activate live execution |

M52 may run after M47 and does not need to wait for credentialed shadow if the
research datasets are offline and user-owned. M53 is intentionally last and is
a review gate, not a live implementation milestone.

---

## 5. Milestone definitions and acceptance gates

### M44 — Reproducible bootstrap and beta onboarding

#### Objective

Make a clean Linux installation reproducible and make the private beta usable by
an operator who does not know the repository internals.

#### Required behavior

- Add a dependency preflight that reports Python, Node, npm, SQLite, Make, Bash,
  disk, permissions, and port availability.
- Add a safe bootstrap wrapper that creates or validates `.venv`, installs only
  the locked Python dependencies, runs `npm ci`, and never requests secrets.
- Add clear `init`, `start`, `stop`, `status`, `check`, and recovery guidance.
- Preserve the current `scripts/fdbtrade` behavior and loopback-only binding.
- Test a clean temporary checkout or documented clean Linux directory.
- Update operator documentation and the fresh-chat handoff only after tests pass.

#### Acceptance

```bash
make bootstrap
make operational-packaging-check
make private-beta-check
make dashboard-check
make security-check
make phase2-check
make handoff-check
```

A clean operator path must reach a ready dashboard without manual Python import
path edits or undocumented packages.

---

### M45 — Continuous scheduler and runtime hardening

#### Objective

Turn the deterministic runtime into a continuously running local process with
safe scheduling, graceful shutdown, and restart-neutral recovery.

#### Required behavior

- One process lock per runtime database.
- Bounded scheduler interval and explicit clock source.
- Cycle lease, heartbeat, timeout, retry, and shutdown states.
- Recovery from interrupted cycles using durable checkpoints.
- No duplicate cycle, job, outbox event, paper order, or fill.
- Health projections for scheduler, queue, database, source, analysis, and paper
  broker.
- Controlled degradation under queue, memory, disk, or stale-data pressure.
- Operational log correlation and bounded retention.

#### Acceptance

- Run the runtime for a bounded multi-hour fixture soak.
- Kill it at multiple checkpoints and restart it.
- Compare durable state and event hashes before and after recovery.
- Prove no duplicate orders or progress jumps.
- Run the full replay, runtime, persistence, packaging, security, and dashboard
  gates.

---

### M46 — User-facing historical research workflow

#### Objective

Make historical CSV import, quality review, replay, and backtest a normal user
workflow rather than a developer command.

#### Required behavior

- Dataset registration with immutable source checksum and version.
- UI or operator command for import preview and approval.
- UTC, OHLC, precision, duplicate, gap, quarantine, and row-limit reporting.
- Dataset list with pair, timeframe, coverage, provenance, and quality state.
- Replay selection that cannot silently substitute fixture data.
- Backtest report linked to dataset checksum, strategy version, code hash, and
  seed.
- Exportable report and reproducible exact retry.

#### Acceptance

- Import a valid user-owned dataset.
- Reject malformed, ambiguous, oversized, or duplicate input.
- Replay and backtest the imported dataset.
- Reopen the database and reproduce the same dataset/report metadata.
- Show historical mode distinctly from fixture and shadow modes.

---

### M47 — Seven-major runtime coverage

#### Objective

Expand the continuously running slice from the proven vertical pair to the
seven configured majors without weakening isolation or safety.

#### Required pair set

```text
EUR_USD
GBP_USD
USD_JPY
USD_CHF
AUD_USD
USD_CAD
NZD_USD
```

#### Required behavior

- Pair-specific ingestion, aggregation, freshness, features, regime, signal,
  risk, and projections.
- One pair may fail without inventing data or taking unrelated pairs offline.
- Pair-level backfill, quarantine, retry, and reconciliation.
- Seven-major resource measurement and bounded load shedding.
- Dashboard filters and pair-level provenance.
- Portfolio exposure and currency-cluster limits remain authoritative.

#### Acceptance

- Full seven-major fixture replay.
- Seven-major restart and crash recovery.
- Pair-isolation fault injection.
- Performance and memory evidence.
- No hard-coded operational pair state in the UI.

---

### M48 — Credentialed read-only provider shadow

#### Objective

Allow an explicitly approved operator to observe real provider market data without
adding any order authority.

#### Required behavior

- Provider terms and account gate.
- Owner-only read secret loading under an approved directory.
- Exact host and GET-only request allowlist.
- Instrument, historical candle, quote, stream, reconnect, duplicate, quota,
  and staleness handling.
- Digest-only raw audit; never persist raw payloads or secrets.
- Provider outage shown as unavailable/degraded/stale.
- No silent fixture fallback.
- Fixture mode remains the default and network-free regression path.

#### Acceptance

- Run the complete mock shadow gate first.
- Run credentialed shadow only when the user explicitly supplies an approved
  local environment outside the repository.
- Prove zero order/trade/position capabilities.
- Prove provider failure does not generate current-looking fixture data.
- Document all unmeasured quota, latency, DNS/TLS, and account limitations.

---

### M49 — Real-time paper operations hardening

#### Objective

Make ongoing paper operation reliable using fixture, historical, or approved
read-only shadow data while keeping confirmation explicit.

#### Required behavior

- Quote freshness, spread, slippage, and clock checks.
- Durable order lifecycle: pending, filled, rejected, cancelled, expired, and
  any explicitly approved partial-fill state.
- Idempotent confirmation and fill operations.
- Portfolio, P&L, exposure, journal, and reconciliation rebuild from durable
  ledger state.
- Emergency stop survives restart and blocks new confirmation.
- Paper statements and export.
- No automatic paper execution unless a separate milestone explicitly approves
  it; default remains explicit operator confirmation.

#### Acceptance

- Multi-day simulated paper soak.
- Restart at order, fill, close, and emergency-stop boundaries.
- Duplicate and divergent idempotency tests.
- Portfolio reconciliation against ledger.
- Dashboard and API show provenance, mode, freshness, and live-false status.

---

### M50 — Upgrade, rollback, and operational distribution

#### Objective

Make the application maintainable after installation.

#### Required behavior

- Versioned upgrade command.
- Pre-upgrade backup.
- Migration preflight and checksum verification.
- Rollback or restore procedure.
- Systemd user unit upgrade behavior.
- Log, backup, disk, and clock monitoring.
- Clean Linux VM installation evidence.
- Optional Docker build/runtime evidence on a Docker-capable host.
- No root service or public port exposure.

#### Acceptance

- Upgrade from the M43 baseline to the new version.
- Restore a pre-upgrade backup.
- Verify projections, jobs, outbox, paper ledger, and checkpoints.
- Verify service start/stop and failure recovery.
- Validate the archive with top-level `FdbTrade/` and no environments, caches,
  logs, or secrets.

---

### M51 — Private remote access and security

#### Objective

Only if required, make the private beta reachable through an authenticated
private network without turning it into public SaaS.

#### Required behavior

- Explicit private-network design and ADR.
- TLS termination.
- Strong authentication and session expiry.
- Viewer/operator/admin least privilege.
- CSRF, origin, rate-limit, and request-size controls.
- Secret manager or documented owner-only secret scope.
- Audit retention and key rotation.
- No public unauthenticated ingress.

#### Acceptance

- Threat model and attack-surface review.
- Security tests from an external private client.
- Backup encryption and restore test.
- Incident and disable procedure.
- Explicit confirmation that remote access adds no live execution authority.

---

### M52 — Research validity and strategy evidence

#### Objective

Prevent technically correct backtests from being mistaken for proof of accuracy
or profitability.

#### Required behavior

- Longer and more diverse user-owned datasets.
- Locked test isolation.
- Walk-forward validation.
- Cost, spread, slippage, and swap stress.
- Sample-size thresholds.
- Parameter neighborhood stability.
- Out-of-sample comparison.
- Explicit inconclusive/rejected states.
- Separate engineering performance from market performance.
- No calibrated probability claim without a validated probability model.

#### Acceptance

- Reproducible reports from immutable dataset/code/config hashes.
- Independent review of leakage and evaluation boundaries.
- No automatic promotion from research to paper or live authority.
- Reports visibly state limitations and uncertainty.

---

### M53 — Live-execution feasibility review

#### Objective

Produce a decision package for whether live execution should ever be considered.
This milestone must not activate live execution.

#### Required review areas

- Legal and compliance requirements.
- Broker terms and account permissions.
- Order API semantics and idempotency.
- Broker reconciliation and position mismatch handling.
- Kill switch and maximum-loss policy.
- Exposure, daily-loss, and weekly-loss controls.
- Network timeout and retry behavior.
- Manual approval policy.
- Security review and secret management.
- Incident response and disable procedure.
- Production monitoring and on-call ownership.
- Independent review of research validity.

#### Acceptance

The output is a signed decision document with one of:

- `NOT_READY`.
- `READY_FOR_SEPARATE_IMPLEMENTATION_PLAN`.
- `REJECTED_FOR_SCOPE/RISK`.

`LIVE_EXECUTION_ENABLED` remains false in every outcome.

---

## 6. Standard agent execution protocol

Every prompt below must be executed with this protocol:

1. Read this file and the current repository authority.
2. Confirm the requested milestone is the only authorized pending milestone.
3. Run a clean baseline before editing.
4. Inspect existing implementation before adding code.
5. Implement only the requested milestone.
6. Prefer the smallest coherent architecture.
7. Add behavior-level tests before claiming completion.
8. Run focused gates, then relevant regression gates.
9. Update checkpoint, ADR/decision, recovery, changelog, inventory, and tests.
10. Run final handoff validation.
11. Commit implementation and documentation changes.
12. Create a separate authority/recovery pin commit if the manifest changes.
13. Package and validate an archive only when the prompt requests it.
14. Report exact commands, counts, hashes, limitations, and the next prompt.
15. Stop. Do not start the next milestone automatically.

### Required agent report format

```text
Milestone: Mxx — <name>
Status: PASS | BLOCKED | FAILED
Scope changed: <short list>
Behavior added: <user-observable list>
Authoritative state: <database/projection/repository>
Focused commands: <exact commands and results>
Regression commands: <exact commands and counts>
Safety checks: live=false, provider-order=false, network boundary=<result>
Implementation commit: <hash>
Authority commit: <hash or N/A>
Archive: <path/hash/size or N/A>
Known limitations: <explicit list>
Next authorized prompt: <exact path or none>
```

### Blocker protocol

If a required gate fails:

- Stop the milestone.
- Do not mark the manifest complete.
- Do not weaken or delete the failing test.
- Record the exact command and first actionable error.
- Explain whether the blocker is code, dependency, environment, data, or
  missing authorization.
- Propose the smallest correction, but wait for the next agent invocation.

---

## 7. Prompt pack

The following prompts are intentionally staged. Copy only one prompt into the
coding agent at a time.

---

## Prompt M44 — Reproducible bootstrap and beta onboarding

You are continuing FdbTrade after Phase 2 M43. Read
`POST_PHASE2_BLUEPRINT_PROMPT_PACK.md` first, then read
`PHASE2_PROGRESS_MANIFEST.json`, `RECOVERY.md`,
`docs/checkpoints/43_private_beta.md`, and the current operator documentation.

M00–M43 are complete. Implement **only M44 — Reproducible bootstrap and beta
onboarding**. Do not repeat or redesign prior milestones.

Before editing, run:

```bash
git status --short --branch
git rev-parse HEAD
make phase2-check
make handoff-check
make private-beta-check
```

Build the smallest behavior-level solution that lets a clean Linux user create
the supported Python environment, install locked dependencies, install Node
dependencies, initialize the runtime, start the loopback services, inspect
status, and recover from common setup failures. Preserve fixture/offline mode,
loopback-only binding, paper-only authority, and both live-false flags.

Required deliverables:

- bootstrap/preflight behavior;
- dependency and version diagnostics;
- safe recovery guidance;
- focused behavior tests;
- updated operator guide, checkpoint, ADR/decision, changelog, recovery, and
  inventory;
- no secrets, credentials, public ingress, live route, or provider order path.

Required gates before completion:

```bash
make bootstrap
make operational-packaging-check
make private-beta-check
make dashboard-check
make security-check
make test
make lint
make typecheck
make format-check
make phase2-check
make handoff-check
```

Commit only M44 changes, report exact counts and hashes, and stop. Do not begin
M45.

---

## Prompt M45 — Continuous scheduler and runtime hardening

Read the blueprint pack and the current M44 checkpoint. Confirm M44 is complete
and M45 is the only authorized pending milestone. Do not repeat M00–M44.

Implement only continuous local scheduling and restart-safe runtime hardening.
Use existing application runtime, SQLite operational tables, jobs, checkpoints,
outbox, reconciliation, and lifecycle commands. Do not create a second runtime
or state authority.

Prove behavior with bounded multi-hour fixture soak, controlled termination at
multiple checkpoint boundaries, restart recovery, duplicate prevention, queue
backpressure, graceful shutdown, and health projections. Preserve offline
fixture regression and all live/order safety flags.

Required gates include:

```bash
make runtime-check
make operational-persistence-check
make operational-packaging-check
make integration-replay-check
make private-beta-check
make test
make security-check
make dashboard-check
make phase2-check
make handoff-check
```

Commit only M45 changes and stop. Do not begin M46.

---

## Prompt M46 — User-facing historical research workflow

Read the blueprint pack and current checkpoint. Confirm M45 is complete and M46
is the only authorized pending milestone. Do not repeat prior milestones.

Implement only the user-facing historical dataset workflow. Use the existing
bounded importer, canonical candle contracts, immutable dataset registry,
provenance, replay loader, backtest engine, API v2, SQLite jobs/projections,
and dashboard. Do not bundle unlicensed market data and do not add network
fallback.

Prove valid import, malformed input rejection, duplicate/gap/quarantine
reporting, immutable versioning, replay, backtest reproducibility, export, and
restart behavior. Distinguish fixture, historical, shadow, stale, unavailable,
and degraded states in the UI/API.

Run focused historical/backtest gates plus full regression, security, replay,
runtime, dashboard, Phase 2 compatibility, and handoff checks. Commit only M46
changes and stop. Do not begin M47.

---

## Prompt M47 — Seven-major runtime coverage

Read the blueprint pack and current checkpoint. Confirm M46 is complete and M47
is the only authorized pending milestone.

Implement only seven-major runtime coverage for:

```text
EUR_USD, GBP_USD, USD_JPY, USD_CHF, AUD_USD, USD_CAD, NZD_USD
```

Use the existing tier policy and authoritative SQLite projections. Prove
pair-level ingestion, freshness, features, regime, signal, risk, dashboard
provenance, backfill, retry, quarantine, reconciliation, pair isolation, and
resource behavior. A failing pair must not produce invented current data or
silently disable unrelated pairs.

Run seven-major behavior tests, restart/fault tests, performance/resource
checks, dashboard checks, security checks, full regression, Phase 2 safety
checks, and handoff validation. Commit only M47 changes and stop. Do not begin
M48.

---

## Prompt M48 — Credentialed read-only provider shadow

Read the blueprint pack and current checkpoint. Confirm M47 is complete and M48
is the only authorized pending milestone.

Implement only an explicitly gated, read-only provider shadow path. Fixture mode
must remain the default. Provider access must use owner-only local read secrets,
exact host and GET allowlists, bounded retries, reconnect, duplicate
suppression, quota/staleness evidence, provenance, and digest-only audit.

Do not add order/trade/position routes, broker order credentials, provider order
transport, live execution, or silent fixture fallback. Never request or paste
secrets into chat. Any credentialed test must be operator-local and optional;
mandatory CI remains network-free.

Run mock shadow gates first, then only explicitly approved local shadow tests.
Document what was not measured. Commit only M48 changes and stop. Do not begin
M49.

---

## Prompt M49 — Real-time paper operations hardening

Read the blueprint pack and current checkpoint. Confirm M48 is complete and M49
is the only authorized pending milestone.

Implement only ongoing paper-operation hardening: quote freshness, spread and
slippage policy, durable lifecycle states, exact idempotency, portfolio/P&L
reconciliation, journal/export, emergency-stop recovery, and bounded simulated
multi-day operation. Keep operator confirmation explicit unless a separately
approved decision changes it.

Use existing paper broker, paper operations service, SQLite ledger, calendar
risk, alerts, jobs, outbox, API v2, and dashboard. Never create live execution
or automatic broker authority.

Run focused paper tests, restart/fault tests, multi-day simulated soak, full
regression, security, replay, runtime, dashboard, packaging, Phase 2, and
handoff gates. Commit only M49 changes and stop. Do not begin M50.

---

## Prompt M50 — Upgrade, rollback, and operational distribution

Read the blueprint pack and current checkpoint. Confirm M49 is complete and M50
is the only authorized pending milestone.

Implement only upgrade, rollback, migration preflight, backup-before-upgrade,
service upgrade, log/backup/disk/clock checks, and clean Linux installation
evidence. Preserve systemd user scope, loopback-only exposure, SQLite
authority, and restore guards. Docker validation is optional and must not be
falsely claimed when unavailable.

Prove upgrade, rollback/restore, migration checksum safety, service recovery,
and archive integrity. Run all relevant operational, security, regression,
phase, and handoff gates. Commit only M50 changes and stop. Do not begin M51.

---

## Prompt M51 — Private remote access and security

Read the blueprint pack and current checkpoint. Confirm M50 is complete and M51
is the only authorized pending milestone.

Implement only an explicitly approved private-network access boundary. First
write the threat model and ADR. Use strong authentication, TLS, private-network
allowlisting, session expiry, least privilege, CSRF/origin/rate-limit controls,
secret scope, audit retention, and disable/recovery procedures.

Do not expose public unauthenticated ingress. Do not add live execution,
provider order transport, or broker credentials. Prove that remote access does
not change the execution authority. Commit only M51 changes and stop. Do not
begin M52.

---

## Prompt M52 — Research validity and strategy evidence

Read the blueprint pack and current checkpoint. Confirm M52 is authorized and
its prerequisites are complete. Do not convert research evidence into trading
authority.

Implement only dataset/research evidence improvements: longer user-owned data,
walk-forward and locked-test isolation, cost/slippage/swap stress,
sample-size thresholds, parameter stability, out-of-sample evidence, explicit
inconclusive states, and reproducible report hashes.

No report may claim guaranteed accuracy or profitability. No strategy may be
automatically promoted to paper or live. Commit only M52 changes and stop.

---

## Prompt M53 — Live-execution feasibility review

Read the blueprint pack and all current checkpoints. Confirm M48–M52 are complete
and M53 is explicitly authorized as a review milestone.

Do not implement or activate live execution. Produce only a feasibility review
covering legal/compliance, broker terms, order semantics, reconciliation,
kill-switch, loss/exposure limits, network failures, manual approval, secrets,
monitoring, incident response, and independent research validity.

The only accepted outcomes are `NOT_READY`,
`READY_FOR_SEPARATE_IMPLEMENTATION_PLAN`, or `REJECTED_FOR_SCOPE/RISK`.
Keep `LIVE_EXECUTION_ENABLED=false` and
`PROVIDER_ORDER_TRANSPORT_ENABLED=false` in every artifact. Commit only the
review documents and tests, then stop.

---

## 8. First next action

Do not implement M44 automatically from this file. The next safe action is to
review this blueprint, confirm the intended post-Phase 2 scope, and explicitly
authorize **M44 — Reproducible bootstrap and beta onboarding**.

Until that authorization is given, the repository remains correctly frozen at
M43 private beta.
