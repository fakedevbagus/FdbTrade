# Phase 2 — Private Beta Risk Register

**Version:** 2.0.0-private-beta  
**Status:** Active (M44 complete, M45 authorized)  
**Baseline:** Legacy P0-P18 roadmap complete

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| R001 | Live execution enabled accidentally | Low | Critical | `LIVE_EXECUTION_ENABLED=false` enforced in config, code, tests; no live routes | Verified — M44 `private-beta-check` |
| R002 | Provider order transport enabled accidentally | Low | Critical | `PROVIDER_ORDER_TRANSPORT_ENABLED=false` enforced; no order routes | Verified — M44 `private-beta-check` |
| R003 | Broker credentials in source/logs | Medium | High | `.env` git-ignored; redaction in health responses; tests scan for secrets | Verified — M44 `security-check` |
| R004 | Public ingress exposed | Medium | High | Loopback-only binding (127.0.0.1); no public ports | Verified — M44 `private-beta-check` |
| R005 | SQLite not yet integrated | Medium | Medium | M44 reports SQLite availability only (CLI binary + stdlib driver); runtime SQLite integration is deferred to a later milestone with its own ADR | Open — deferred beyond M44 |
| R006 | No operator bootstrap | High | High | `scripts/fdbtrade` + `make bootstrap` implemented in M44 | Mitigated — M44 |
| R007 | Missing recovery guidance | Medium | Medium | `RECOVERY.md` + `scripts/fdbtrade recover` implemented in M44 | Mitigated — M44 |
| R008 | No format-check | Medium | Low | `make format-check` added in M44 (syntax + placeholder + filename portability) | Mitigated — M44 |
| R009 | Fresh chat context lost | Medium | Medium | `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md` updated in M44 | Mitigated — M44 |
| R010 | Outdated checkpoint state | Medium | High | `docs/checkpoints/43_private_beta.md` + `docs/checkpoints/44_bootstrap.md` created in M44 | Mitigated — M44 |
| R011 | Legacy milestones accidentally rewritten | Low | High | Blueprint says legacy manifest frozen; M44 only touched post-Phase 2 files | Verified — M44 |
| R012 | Test suite regression | Medium | High | Full `make test` + all Phase 2 gates after M44 | Verified — M44 |
| R013 | Clean checkout fails | Medium | High | Clean temporary checkout dry-run asserted in `tests/test_m44_bootstrap_contracts.py` | Verified — M44 |
| R014 | Dependency drift (pnpm lock) | Medium | Medium | `pnpm install --frozen-lockfile` in bootstrap; missing lockfile fails closed (tested) | Verified — M44 |
| R015 | No SQLite binary | Medium | Medium | Preflight reports the CLI binary and the Python stdlib `sqlite3` module separately; missing binary is a warning only | Verified — M44 |
| R016 | Port conflict (3000/3100/15432) | High | Medium | Preflight checks ports; `fdbtrade stop` before start; clear error messages | Open — M44 verify |
| R017 | `.env` missing/corrupt | Medium | High | `cp infra/.env.example .env` + `make db-up`; recovery documented | Open — M44 verify |
| R018 | venv corrupt/missing | Medium | Medium | `rm -rf .venv && make bootstrap`; idempotent init | Open — M44 verify |
| R019 | Docker unavailable | Low | Medium | Preflight reports; skip DB checks gracefully; docs recovery | Open — M44 verify |
| R020 | Manual import path edits needed | Medium | High | `.venv` auto-created; `PYTHONPATH` documented; tests clean checkout | Open — M44 verify |
| R021 | Automatic paper execution | Low | High | Paper broker requires explicit confirmation; no auto-execution | Open — M44 verify |
| R022 | Incomplete operator docs | Medium | Medium | Operator guide + handoff prompt in M44 | Open — M44 implement |

## M44 Risk Closure Criteria

All R001–R022 must be closed or explicitly documented as residual risk after M44 gates pass.

---
*Generated at M43 handoff. Updated for M44 bootstrap implementation.*