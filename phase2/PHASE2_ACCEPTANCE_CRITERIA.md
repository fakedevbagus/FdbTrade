# Phase 2 — Private Beta Acceptance Criteria

**Version:** 2.0.0-private-beta  
**Status:** Active (M44 complete, M45 authorized)  
**Baseline:** Legacy P0-P18 roadmap complete

## Acceptance Framework

Every Phase 2 milestone must pass its own acceptance gate, then the full regression suite. No milestone may weaken an earlier acceptance gate.

## Phase 2 Milestone Acceptance Matrix

| Milestone | Name | Required Acceptance | Status |
|---|---|---|---|
| M44 | Reproducible bootstrap and beta onboarding | Clean Linux install, preflight, bootstrap, init/start/stop/status/check, recovery, loopback-only, no secrets | **COMPLETE — all seven M44 gates pass** |
| M45 | Continuous scheduler and runtime hardening | Process lock, scheduler state machine, restart recovery, no duplicates, health projections, soak test | **AUTHORIZED NEXT — M44 complete** |
| M46 | User-facing historical research workflow | Dataset import/preview, quality gates, immutable registry, replay, backtest, export, provenance | Blocked — depends on M45 |
| M47 | Seven-major runtime coverage | 7 majors with isolation, backfill, retry, quarantine, resource measurement | Blocked — depends on M46 |
| M48 | Credentialed read-only provider shadow | Secret loading, allowlists, outage handling, digest audit, no fixture fallback | Blocked — depends on M47 |
| M49 | Real-time paper operations hardening | Freshness, durable lifecycle, idempotency, reconciliation, emergency stop | Blocked — depends on M48 |
| M50 | Upgrade, rollback, operational distribution | Versioned upgrade, backup, migration preflight, systemd, archive integrity | Blocked — depends on M49 |
| M51 | Private remote access and security | TLS, auth, least privilege, CSRF, rate limit, no public ingress | Blocked — depends on M50 |
| M52 | Research validity and strategy evidence | Walk-forward, locked test, stress, sample thresholds, inconclusive states | Blocked — depends on M47 |
| M53 | Live-execution feasibility review | Decision package only; no live execution | Blocked — depends on M48-M52 |

## Universal Phase 2 Non-Negotiables

- `LIVE_EXECUTION_ENABLED=false` in code, configuration, tests, reports, runtime
- `PROVIDER_ORDER_TRANSPORT_ENABLED=false` everywhere
- No live-money order or trade route
- No broker order credential, account secret, or secret pasted into chat
- Provider access = read-only market-data shadow only
- No hidden fallback from provider data to fixture-looking current data
- Missing, stale, inconsistent, unavailable, or unverified safety data fails closed
- SQLite remains authoritative private-beta store until measured evidence + ADR justify another DB
- Existing domain services are wrapped rather than rewritten
- Offline fixture replay remains mandatory regression infrastructure
- Every mutation is idempotent or fails on divergent reuse
- Every milestone survives restart or documents why no durable state
- Every milestone gets its own implementation commit and verification result
- No automatic paper execution without separate approval

## M44 Acceptance Gates (Current)

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

## Gate Failure Protocol

If a required gate fails:
1. Stop the milestone.
2. Do not mark the manifest complete.
3. Do not weaken or delete the failing test.
4. Record exact command and first actionable error.
5. Explain blocker type: code, dependency, environment, data, or missing authorization.
6. Propose smallest correction, wait for next agent invocation.

---
*Generated at M43 handoff. Updated for M44 bootstrap implementation.*