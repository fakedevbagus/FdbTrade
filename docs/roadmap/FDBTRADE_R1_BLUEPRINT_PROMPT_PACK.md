# FdbTrade R1 Blueprint and Staged Prompt Pack

Status: APPROVED ROADMAP; implementation remains unit-authorized

Recorded: 2026-09-24

Pre-R1 baseline: `1773f257c1f9877774880e36406e45e2a8ae5918` on
`rebuild/r0-preserve-current-state`

This is the canonical plan and prompt source for FdbTrade R1. It supersedes
the future scheduling of `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`, but it does
not rewrite or weaken any completed R0.1-R0.12 authority.

## 1. How to use this file

FdbTrade is developed one bounded work unit per chat.

1. Open a new chat in the repository.
2. Ask the agent to read this file and `docs/rebuild/NEXT.md`.
3. Copy the exact prompt for the unit named by `NEXT.md`.
4. The unit ends after focused verification, the complete toolchain gate,
   authority documentation, one atomic commit and a copy-ready handoff.
5. Start another chat for the next unit.

The prompt pack is a plan, not standing authorization. A prompt only
authorizes the unit it names. A bare `continue`, `kerjakan`, or reference to
this roadmap never authorizes a later unit or a wider scope.

At the end of every completed unit, the implementing agent must include the
next prompt in `docs/rebuild/NEXT.md` and in its final response. The prompt
must contain the actual predecessor commit, not a guessed future hash.

## 2. Product contract

FdbTrade R1 is a private, single-user, Linux-local forex intelligence system.
Its product ceiling is decision support, historical research, alerts and
operator-confirmed paper trading. It does not promise profit and must prefer
an explained abstention over weak or fabricated certainty.

Information is valid enough for use only when:

- source, timestamps, dataset, configuration and subject lineage are explicit;
- data bytes and metadata pass their applicable integrity and quality checks;
- results are reproducible and avoid look-ahead or future leakage;
- research claims use chronological out-of-sample evidence and realistic cost
  assumptions;
- operational signals, historical research, paper outcomes and challenger
  experiments remain visibly distinct evidence classes;
- stale, missing, corrupt or insufficient evidence becomes `wait`, `blocked`,
  `failed`, `degraded` or `down`, never fabricated green or confidence;
- risks, costs, limitations and provenance are presented with the conclusion.

Priority order:

1. trustworthy data and evidence;
2. signal quality and explained abstention;
3. research validity;
4. independent risk and paper-trading integrity;
5. security, recovery and operational truth;
6. usable UI projections;
7. provider and automation expansion;
8. deterministic and ML challengers.

## 3. Locked boundaries

These boundaries apply to every R1 unit unless a later user authorization
explicitly amends the blueprint itself:

- SQLite is the only mutable durable metadata authority.
- Immutable data/research artifacts remain content-addressed below
  `FDB_DATA_ROOT`; SHA-256 is integrity evidence, not authenticity.
- Backup directories are immutable evidence, not metadata authority.
- A published backup without an operational event is unclaimed by SQLite.
- The trading universe is exactly EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD,
  USDCAD and NZDUSD.
- Supported timeframes are exactly 15m, 1h and 4h.
- R0.6 artifacts, R0.7 signals, R0.8 research evidence and R0.9
  risk/paper/outcome authority retain their meaning.
- A persisted approved risk decision is mandatory before paper execution.
- Kill is durable and latched; release lands in red.
- Paper outcomes are not signal confidence, live evidence or automatic
  strategy/model-promotion evidence.
- UI, health pages, reports and backup directories are projections/evidence,
  never competing mutable authority.
- ML is challenger-only until a separately authorized promotion design exists.
- Live execution is OFF. Demo execution and provider-order transport are OFF.
- Paper execution always requires an explicit operator action.
- No credentialed/network provider is selected at R1.0.
- M48 remains quarantined and non-authoritative; its ten preservation hashes
  must continue to match `artifacts/rebuild/r0.1/preservation.json`.
- Remote access, LAN deployment, mobile clients, monetization, XAUUSD, 5m and
  1D are outside R1.

## 4. Current authority and evidenced gaps

Completed authority:

- R0.1 preservation and M48 quarantine;
- R0.2 observable capability audit;
- R0.3 reproducible bounded toolchain;
- R0.4 SQLite foundation;
- R0.5 local lifecycle and durable runtime coordination;
- R0.6 immutable market-data artifact authority;
- R0.7 deterministic signal authority;
- R0.8 historical research/backtest authority;
- R0.9 risk, paper broker and outcome authority;
- R0.10 UI/operational projections and backup/restore;
- R0.11 crash-consistent operational publication;
- R0.12 operator-triggered authoritative signal evaluation API.

Proven gaps:

- R0.12 has no complete authoritative signal workbench/read projection.
- R0.8 has no production operator API or UI; the old backtest API is separate
  legacy behavior.
- R0.9 has no production paper-run API or operator workflow.
- Paper conversion, spread and slippage inputs need stronger authoritative
  resolution before being exposed to an operator UI.
- Some scanner, dashboard, signal-detail and backtest surfaces retain legacy or
  fixture provenance.
- Default queue health is a hard-coded zero observation, feed health has no
  authoritative provider evidence and some API error evidence is process-local.
- R0.8 does not claim walk-forward/OOS orchestration, robustness or
  multiple-testing control.
- The production scheduler is observation-only and off by default.

Risks requiring evidence rather than assumptions:

- CSRF/origin enforcement, login throttling, session rotation/revocation,
  filesystem permissions and log redaction need a focused security audit.
- Upgrade/migration failure and disk-capacity recovery need executable drills.
- Network providers introduce credential, egress, DNS/SSRF, licensing,
  rate-limit, drift and outage risks.

Not authorized at R1.0:

- provider selection or provider network access;
- M48 runtime wiring;
- macro provider selection;
- strategy/model promotion;
- automated paper execution;
- demo or live execution;
- any universe, timeframe or deployment expansion.

## 5. Roadmap and dependency order

### Tranche A - authoritative operator workflow

| Unit | Name | Terminal capability |
|---|---|---|
| R1.1 | Authoritative Signal Workbench | Operator can create and inspect R0.7 evaluations without legacy scanner authority. |
| R1.2 | Authoritative Research API | Authenticated API invokes and reopens R0.8 evidence. |
| R1.3 | Research Workbench UI | Operator can run and inspect one authoritative baseline research run. |
| R1.4 | Temporal Validation Authority | Chronological OOS and walk-forward evidence is durable and reproducible. |
| R1.5 | Robustness and Selection-Bias Evidence | Cost, sensitivity, sample and multiple-testing limitations are explicit. |
| R1.6 | Paper Input Resolution | Conversion and paper-cost inputs have verified deterministic provenance. |
| R1.7 | Operator-Confirmed Paper API | One explicit operator call invokes R0.9 without bypassing durable risk. |
| R1.8 | Paper and Outcome Workbench | UI projects risk, ledger, reconciliation and paper-only outcomes. |
| R1.9 | Legacy Surface Retirement | Ambiguous fixture/legacy trading surfaces cannot appear authoritative. |

### Tranche B - reliability, security and offline private beta

| Unit | Name | Terminal capability |
|---|---|---|
| R1.10 | Durable Operational Health | Health reflects durable queue/run/data/risk/artifact facts. |
| R1.11 | Local Web Security Hardening | Local mutation/auth/session/filesystem boundaries are behavior-tested. |
| R1.12 | Upgrade and Rollback Safety | Upgrade failure and verified recovery have executable evidence. |
| R1.13 | Offline Private Beta Gate | The complete offline decision-to-paper loop passes an operator drill. |

### Tranche C - read-only provider and analysis automation

| Unit | Name | Terminal capability |
|---|---|---|
| R1.14 | Provider Selection Dossier | Evidence-based provider options are documented; no provider is chosen automatically. |
| R1.15 | Credential and Egress Boundary | One explicitly chosen provider can be called through a hardened read-only boundary. |
| R1.16 | Credentialed Read-Only Shadow | Provider evidence is compared without becoming authority. |
| R1.17 | Authoritative Provider Ingestion | Accepted provider candles publish through R0.6. |
| R1.18 | Scheduled Analysis and Alerts | Scheduler may ingest/evaluate/alert, never execute paper orders. |

### Tranche D - macro context and challenger research

| Unit | Name | Terminal capability |
|---|---|---|
| R1.19 | Macro Source Selection Dossier | Calendar-source options are evaluated without selecting one automatically. |
| R1.20 | Macro Calendar Authority | Calendar events and revisions have immutable provenance. |
| R1.21 | Macro Context and Event-Risk UI | Macro evidence informs context/blackouts but cannot originate orders. |
| R1.22 | Deterministic Strategy Challenger Lifecycle | New deterministic rules remain challengers until explicit promotion. |
| R1.23 | ML Challenger Research | Offline ML evidence is reproducible, leakage-tested and non-authoritative. |
| R1.24 | R1 Release Closure | Security, recovery, soak and operator evidence close R1 without live execution. |

The order is binding. Skipping a unit requires a blueprint amendment that
explains why every downstream dependency remains valid.

## 6. Standard execution protocol

Every implementation prompt below inherits this protocol.

### Start gate

Before editing:

1. Read this file, `docs/rebuild/NEXT.md`, the predecessor checkpoint,
   predecessor authority artifact and relevant ADR/source/tests.
2. Verify branch `rebuild/r0-preserve-current-state`.
3. Verify HEAD equals the predecessor commit recorded in `NEXT.md`.
4. Verify the worktree is clean.
5. Verify `artifacts/toolchain/gate.json` is 15/15 PASS with zero failure,
   timeout, environment block, planned item or skip.
6. Verify ordered migrations and all ten M48 preservation hashes.
7. Verify safety flags remain false.

If any start condition fails, stop with evidence. Do not repair an unknown or
unrelated state inside the unit.

### Implementation discipline

- Work only on the named unit.
- Inspect actual production wiring before changing it.
- Prefer adapters over duplicate business logic.
- Use strict schemas and reject unknown boundary fields.
- Preserve idempotency, deterministic replay, recovery and corruption checks.
- Keep build-time durable access lazy.
- Use temporary `FDB_DATA_ROOT` and file-backed SQLite for behavioral tests.
- Do not use external network, credentials, Docker, PostgreSQL or Redis unless
  the named unit explicitly authorizes the exact dependency.
- Do not clean, rewrite or adopt unrelated worktree changes.

### Evidence and final gate

Each unit must add or update:

- focused behavior tests and negative/failure tests;
- a numbered ADR when a durable design decision changes;
- one machine-readable authority artifact under `artifacts/rebuild/<unit>/`;
- one checkpoint under `docs/rebuild/checkpoints/`;
- `docs/rebuild/NEXT.md` with a copy-ready next-chat prompt;
- this roadmap only if an approved amendment is necessary.

Run focused lint/typecheck/tests, `git diff --check`, relevant operational
checks and finally `make toolchain-gate`. Acceptance requires all 15 commands
to pass with zero non-pass result. Partial logs, static markers, test names,
timeouts or environment-blocked commands are not PASS.

### Commit and stop

- Review the exact diff and confirm no unrelated file changed.
- Create exactly one atomic commit for the unit.
- Recheck clean worktree and record the commit hash.
- Report observable behavior, test evidence, preserved boundaries, risks and
  the copy-ready next prompt.
- Stop. Never begin the next unit in the same chat.

### Rollback

- Before commit, revert only files introduced or changed by the current unit.
- After commit without durable schema/data changes, use an atomic revert.
- After migration/data changes, use a compensating migration or verified R0.11
  backup restore. Never use a destructive database reset as production rollback.
- Preserve valid immutable artifacts and operational evidence during rollback.

## 7. Tranche A prompts

### Prompt R1.1 - Authoritative Signal Workbench

```text
Otorisasi implementasi HANYA R1.1 - Authoritative Signal Workbench sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the prompt pack standard protocol. Build an authenticated read projection
for R0.7 evaluation runs/candidates and an operator UI that selects an existing
R0.6 dataset, submits the existing R0.12 POST endpoint and displays candidate,
wait, blocked or failed evidence with dataset/rule/timestamp lineage. Reopen
state from SQLite; UI is projection only.

Do not invoke R0.8 or R0.9, change signal rules, add scheduling, use the legacy
fixture scanner as authority, select a provider or touch M48. Test strict route
boundaries, list/detail ordering, empty/error states, duplicate replay,
file-backed reopen and cross-authority non-mutation. Add ADR if needed,
authority JSON, checkpoint and NEXT handoff. Run the complete gate, commit once
and stop.
```

### Prompt R1.2 - Authoritative Research API

```text
Otorisasi implementasi HANYA R1.2 - Authoritative Research API sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add authenticated strict POST/GET
/api/research/runs and GET /api/research/runs/{id} adapters over the existing
R0.8 ResearchBacktestAuthority. A POST accepts only an existing R0.6 dataset
identity and the minimum explicit UTC request data required by R0.8. Before
execution register/verify the frozen baseline, run recovery and fail closed on
corrupt evidence. GET endpoints are SQLite/artifact-backed projections.

Do not rewire or promote the legacy /api/backtest/runs route, add parameter
sweeps, change research assumptions, calibrate confidence, invoke risk/paper,
select a provider or touch M48. Prove auth, strict schema, quality blocking,
idempotency, restart recovery, artifact tamper rejection and R0.7/R0.9
non-mutation. Add authority docs, run the full gate, commit once and stop.
```

### Prompt R1.3 - Research Workbench UI

```text
Otorisasi implementasi HANYA R1.3 - Research Workbench UI sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Build a projection-only research workflow over
R1.2: select an eligible R0.6 dataset, explicitly start one baseline run, then
show lifecycle, metrics, costs, artifact/source lineage and the historical-only,
uncalibrated, non-promotion interpretation. Handle empty, loading, blocked,
failed, stale-session and backend-unavailable states truthfully.

Do not add parameter optimization, editable strategy logic, confidence,
automatic promotion, paper execution, provider access or scheduling. Add
frontend boundary/component tests plus backend contract coverage where needed,
authority docs, full gate, one commit and stop.
```

### Prompt R1.4 - Temporal Validation Authority

```text
Otorisasi implementasi HANYA R1.4 - Temporal Validation Authority sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Design and implement a separate SQLite and
immutable-artifact authority for chronological train/validation/test and
rolling walk-forward evaluation of the frozen deterministic baseline. Pin
dataset/config/split lineage, embargo boundaries, costs and deterministic seed.
Reject overlapping or future-leaking splits. Recovery and replay must verify
all input and output evidence.

This evidence must remain historical and non-promotional. Do not change R0.7
signals, infer confidence, search parameters, add ML, invoke paper, use network
data or touch M48. Include migration order/rollback-reapply, temporal leakage
negative tests, restart/tamper behavior, authority docs, full gate, one commit
and stop.
```

### Prompt R1.5 - Robustness and Selection-Bias Evidence

```text
Otorisasi implementasi HANYA R1.5 - Robustness and Selection-Bias Evidence
sesuai docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik,
lalu berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Extend the R1.4 research-evidence layer with
bounded predeclared cost/slippage stress, sensitivity ranges, minimum sample
requirements, regime/timeframe breakdown and a durable experiment ledger that
prevents silently selecting only favorable trials. Produce explicit pass,
insufficient-evidence or rejected conclusions with limitations.

Do not tune production rules, create automatic promotion, treat research as
signal confidence, add ML/provider/paper behavior or widen scope. Test sparse
samples, unstable results, adverse costs, duplicate experiments, restart and
tamper rejection. Add authority docs, full gate, one commit and stop.
```

### Prompt R1.6 - Paper Input Resolution

```text
Otorisasi implementasi HANYA R1.6 - Paper Input Resolution sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add deterministic verified resolution for every
R0.9 paper-run input that must not be trusted from a UI: USD conversion lineage
for all seven pairs and registered baseline spread/slippage assumptions until
provider observations exist. Bind values to the signal/execution dataset,
event time and config digest. Fail closed when conversion or compatible bars
cannot be proven.

Do not add a public paper-run route or UI, change risk limits, accept arbitrary
conversion provenance, select/call a provider, schedule work or touch M48.
Test all seven pair orientations, timestamps, stale/missing/mismatched evidence,
config drift and deterministic replay. Add authority docs, full gate, one
commit and stop.
```

### Prompt R1.7 - Operator-Confirmed Paper API

```text
Otorisasi implementasi HANYA R1.7 - Operator-Confirmed Paper API sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add authenticated strict POST/GET /api/paper/runs
and GET /api/paper/runs/{id} adapters over R0.9 using R1.6-resolved inputs. One
POST is the explicit operator confirmation. Recovery/reconciliation must run
before new work; a persisted approved risk decision must precede paper submit,
fill and outcome events. Return blocked/rejected/failed states truthfully.

Do not add automatic execution, provider orders, live/demo behavior, caller-
supplied authoritative costs/conversion, risk bypass, strategy promotion or
M48 wiring. Prove auth, strict schema, kill/release behavior, rejected decision
without fills, idempotency, divergent replay rejection, restart recovery,
ledger reconciliation and cross-authority integrity. Add authority docs, full
gate, one commit and stop.
```

### Prompt R1.8 - Paper and Outcome Workbench

```text
Otorisasi implementasi HANYA R1.8 - Paper and Outcome Workbench sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Build a projection-only UI for reviewing an
active authoritative candidate, resolved paper assumptions, quantity, current
durable risk state and an explicit confirmation step. Project risk verdict,
paper order/fill/position ledger, reconciliation and paper-only outcome. Make
kill/red states and every limitation prominent.

Do not add background submission, one-click live/demo language, browser-side
authority, confidence changes, provider access or M48. Test confirmation,
double-submit replay, kill/release, blocked/rejected/failure states, refresh
after restart and backend unavailability. Add authority docs, full gate, one
commit and stop.
```

### Prompt R1.9 - Legacy Surface Retirement

```text
Otorisasi implementasi HANYA R1.9 - Legacy Surface Retirement sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Inventory production-visible scanner, dashboard,
signal detail, historical import and backtest surfaces. Migrate useful
projections to R0/R1 authority and make remaining legacy/fixture endpoints
explicitly unavailable or unmistakably non-authoritative. Enforce exactly the
seven pairs and 15m/1h/4h at all public boundaries.

Do not delete preserved evidence, redesign algorithms, add providers, expand
scope, change authorities or touch M48. Prove no UI or production route can
present fixture/legacy results as authoritative, including negative route and
scope tests. Add authority docs, full gate, one commit and stop.
```

## 8. Tranche B prompts

### Prompt R1.10 - Durable Operational Health

```text
Otorisasi implementasi HANYA R1.10 - Durable Operational Health sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Replace invented/default operational health with
truthful projections from durable pending/running runs, latest accepted data,
artifact verification, SQLite/risk state, disk budget and durable error/audit
evidence. Unknown evidence must degrade or fail closed. Keep health read-only.

Do not select a provider, label absent feed data healthy, add scheduler work,
mutate risk/trading state from health or touch M48. Test file-backed restart,
stale/unknown/corrupt states, queue backlog and UI propagation. Add authority
docs, full gate, one commit and stop.
```

### Prompt R1.11 - Local Web Security Hardening

```text
Otorisasi implementasi HANYA R1.11 - Local Web Security Hardening sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Perform an evidence-based local threat review and
close one bounded security authority covering mutation origin/CSRF defense,
login throttling, session rotation/revocation, loopback binding, sensitive file
permissions, response headers and secret/log redaction. Preserve single-user
local deployment and fail closed on uncertain identity.

Do not add remote/LAN exposure, OAuth/cloud identity, MFA theater, provider
credentials, network calls, trading behavior or M48. Include adversarial route
tests, restart/session tests, permission checks and log/response leak tests.
Add ADR, authority artifact, checkpoint, full gate, one commit and stop.
```

### Prompt R1.12 - Upgrade and Rollback Safety

```text
Otorisasi implementasi HANYA R1.12 - Upgrade and Rollback Safety sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add a bounded local preflight and upgrade drill:
verify version/schema/artifacts/disk, create and verify an R0.11 backup, apply
migrations in a temporary restored root, reopen authorities, inject failure
before publication and prove recovery. Production rollback uses verified
restore or compensating migration, never reset.

Do not add an auto-updater, external distribution service, Docker/cloud
deployment, provider work or feature changes. Prove failure isolation,
non-empty target rejection, old/new manifest compatibility policy and restart.
Add authority docs, full gate, one commit and stop.
```

### Prompt R1.13 - Offline Private Beta Gate

```text
Otorisasi implementasi HANYA R1.13 - Offline Private Beta Gate sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add no new product feature. Build and execute a
hermetic operator drill covering bootstrap/login, CSV import, signal workbench,
research plus validation evidence, operator-confirmed paper run, outcome,
health, shutdown/restart, backup, restore and reopen. Add bounded soak and an
operator guide with honest limitations and incident recovery.

Do not use network/credentials, provider/M48, automatic paper, remote access,
demo/live or scope expansion. Every step must verify durable observable state,
not static markers. Record a private-beta authority artifact only if all
focused checks and the complete gate pass. Commit once and stop.
```

## 9. Tranche C prompts

### Prompt R1.14 - Provider Selection Dossier

```text
Otorisasi audit HANYA R1.14 - Provider Selection Dossier sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit dokumentasi
atomik, lalu berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol for a read-only decision unit. Define measurable
requirements and compare credible free/user-owned-first read-only FX data
options for the seven pairs and 15m/1h/4h: candle semantics, history, latency,
freshness, revisions, licensing, exportability, cost, rate limits, uptime,
authentication, SDK independence and testability. Separate sourced fact,
inference and unknown.

Do not create credentials, call provider APIs, select a winner on the user's
behalf, wire M48 or modify production behavior. Produce a decision matrix,
recommended shortlist, rejection reasons and a copy-ready prompt asking the
user to authorize one named provider or defer. Commit evidence/docs once and
stop.
```

### Prompt R1.15 - Credential and Egress Boundary

```text
Otorisasi implementasi HANYA R1.15 - Credential and Egress Boundary untuk
provider <NAMA_PROVIDER_YANG_SUDAH_DISETUJUI> sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Do not run this prompt until the user replaces the placeholder with the exact
provider selected after R1.14. Apply the standard protocol. Implement only the
credential loader and bounded read-only transport foundation: local secret
permissions, redaction, exact HTTPS origin/path/method/query allowlist, DNS/IP
defense, timeout, retry/rate budget and auditable failures. Use hermetic fake
transport for tests; no production ingestion yet.

Do not submit orders, expose secrets, add UI credentials, make unapproved
network calls, promote M48 wholesale or change R0.6. Add security behavior
tests, authority docs, full gate, one commit and stop.
```

### Prompt R1.16 - Credentialed Read-Only Shadow

```text
Otorisasi implementasi HANYA R1.16 - Credentialed Read-Only Shadow untuk
provider yang disetujui sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Audit any reusable M48 file byte-for-byte before
use; adoption requires explicit reviewed provenance and must not change the
R0.1 preserved copy. Add a bounded operator-triggered read-only shadow that
normalizes provider responses and compares coverage, candle closure, timestamps
and drift without publishing R0.6 authority. Fail closed without credentials.

No scheduler, fixture fallback, authoritative ingestion, browser secret,
provider orders, paper automation or live/demo behavior. Tests remain hermetic;
any real credentialed smoke test is optional, operator-run and recorded
separately without secrets. Add authority docs, full gate, one commit and stop.
```

### Prompt R1.17 - Authoritative Provider Ingestion

```text
Otorisasi implementasi HANYA R1.17 - Authoritative Provider Ingestion untuk
provider yang disetujui sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Connect accepted read-only provider candles to
the existing R0.6 ingestion job and immutable artifact publication path.
Require exact scope, closed bars, provenance/licensing, quality/freshness,
bounded pagination/retry and idempotent recovery. Provider failure must not
fall back to fixture or publish partial authority.

Do not schedule ingestion, create signals automatically, submit orders,
expand pairs/timeframes, add another provider or weaken R0.6. Test all network
behavior through deterministic transports plus restart, partial page,
rate-limit, stale, duplicate, gap, tamper and crash boundaries. Add authority
docs, full gate, one commit and stop.
```

### Prompt R1.18 - Scheduled Analysis and Alerts

```text
Otorisasi implementasi HANYA R1.18 - Scheduled Analysis and Alerts sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Replace observation-only stages only where
explicitly required to schedule authoritative provider ingestion, R0.7
evaluation and durable in-app alert creation. Preserve single-process lock,
leases, checkpoints, dedupe, bounded backlog, market-session behavior,
graceful drain and restart recovery. Scheduler stays opt-in and off by default.

The scheduler must have no R0.9 paper-run call, order authority, model
promotion or provider-order transport. Test duplicate ticks, crash at each
stage, stale/down provider, queue pressure, kill state visibility and zero
paper-table mutations. Add authority docs, full gate, one commit and stop.
```

## 10. Tranche D prompts

### Prompt R1.19 - Macro Source Selection Dossier

```text
Otorisasi audit HANYA R1.19 - Macro Source Selection Dossier sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit dokumentasi
atomik, lalu berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the read-only decision protocol. Define calendar-data requirements and
compare sources for scheduled FX-relevant events: licensing, revisions,
timezone semantics, country/currency mapping, impact, actual/forecast/previous,
history, rate limits, cost, exportability and reliability. Separate sourced
facts, inference and unknown.

Do not create credentials, call APIs, select a source for the user, ingest
data, add sentiment/news scraping or alter signals/risk. Produce a shortlist
and a copy-ready prompt requiring one exact macro source authorization. Commit
docs/evidence once and stop.
```

### Prompt R1.20 - Macro Calendar Authority

```text
Otorisasi implementasi HANYA R1.20 - Macro Calendar Authority untuk sumber
yang telah disetujui sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add immutable raw/normalized calendar evidence
and SQLite metadata for source version, fetch time, event identity, scheduled
time, currencies, impact, values and revisions. Normalize to UTC, distinguish
unknown from absent, and preserve every revision. Add bounded secure transport
through the approved egress pattern.

Do not modify signals, risk verdicts, schedule automated trading, add free-form
news/sentiment or select another source. Test DST/timezone, revisions,
duplicates, missing values, stale/outage, restart, tamper and backup/restore.
Add authority docs, full gate, one commit and stop.
```

### Prompt R1.21 - Macro Context and Event-Risk UI

```text
Otorisasi implementasi HANYA R1.21 - Macro Context and Event-Risk UI sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add a deterministic projection joining relevant
currency events to signals by event time and explicit pre/post windows. Display
upcoming/recent events, freshness, revision state and limitations. A registered
event-risk policy may block or warn on new paper entries, but macro evidence
cannot create a signal or order.

Do not add LLM summaries, scraped news, sentiment scores, hidden risk bypass,
strategy changes or automatic paper. Test pair/currency mapping, boundary
times, stale/unknown data, revisions and UI/backend consistency. Add authority
docs, full gate, one commit and stop.
```

### Prompt R1.22 - Deterministic Strategy Challenger Lifecycle

```text
Otorisasi implementasi HANYA R1.22 - Deterministic Strategy Challenger
Lifecycle sesuai docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit
atomik, lalu berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add a registry and immutable evaluation lifecycle
for new deterministic challenger rules. Every challenger must use R1.4/R1.5
evidence, predeclared acceptance thresholds, versioned configuration and an
explicit rejected/insufficient/eligible conclusion. Eligibility is not
production promotion.

Do not replace the R0.7 baseline, auto-select the best trial, use final test
sets for tuning, add ML, change risk or create promotion authority. Test
lineage, threshold boundaries, repeated trials, rejected evidence, restart and
tamper. Add authority docs, full gate, one commit and stop.
```

### Prompt R1.23 - ML Challenger Research

```text
Otorisasi implementasi HANYA R1.23 - ML Challenger Research sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add an offline-only reproducible ML challenger
experiment path with frozen feature lineage, chronological splits, deterministic
seed/environment manifest, leakage tests, calibration diagnostics, drift
measurements and comparison against deterministic baseline. Store artifacts
immutably and label every result non-authoritative.

Do not install unapproved heavy infrastructure, use network training data,
write production signals, infer live confidence, promote a model, invoke risk
or paper, or give an LLM order authority. Test reproducibility, leakage,
miscalibration, drift, sparse data, restart and tamper. Add authority docs,
full gate, one commit and stop.
```

### Prompt R1.24 - R1 Release Closure

```text
Otorisasi implementasi HANYA R1.24 - R1 Release Closure sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade

Apply the standard protocol. Add no new trading feature. Audit every R1
authority and execute bounded performance/soak, security, migration,
backup/restore, provider-outage, scheduler-recovery and end-to-end operator
drills. Reconcile documentation, API inventory, migrations, artifacts,
dependencies, known limitations and unresolved-risk register.

R1 can close only with observable zero-skip evidence and preserved safety:
local single user, paper manual, provider order OFF, demo/live OFF, M48
quarantine history intact and no model promotion. Produce final authority,
checkpoint and a proposal-only future handoff. Run the full gate, commit once
and stop.
```

## 11. Blocker and amendment protocol

Stop the current unit without speculative implementation when:

- the checkout does not match the recorded predecessor;
- the worktree is already dirty and ownership is unclear;
- predecessor evidence or M48 preservation fails;
- a required provider/source/user choice is missing;
- completion would require a wider universe, timeframe, deployment or
  execution mode;
- a migration cannot preserve rollback/restore safety;
- focused tests or the complete gate cannot pass without hiding a failure.

A blocker report must state the exact evidence, completed safe checks, files
left unchanged, and the smallest decision needed. It must not mark the unit
complete or advance `NEXT.md`.

Any roadmap amendment must be an explicitly named documentation-only unit. It
must explain the evidence that invalidated the plan, downstream units affected,
new dependencies, preserved safety boundaries and replacement prompts. An
implementation chat cannot silently amend its own scope.
