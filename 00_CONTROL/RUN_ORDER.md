# FdbTrade Prompt Pack v1 - Run Order

Run prompts in lexical order by phase, then by sequence number. Do not skip a prompt unless its completion report says the output already exists and tests pass.

## Phase acceptance gates
- P0: repository runnable, architecture ADR, env contract, coding rules.
- P1: web/API/DB/auth foundation works locally.
- P2: provider abstraction + fixture feed + canonical bars/quotes + quality checks.
- P3: versioned features and snapshots with fixtures.
- P4: deterministic regime classifier with tests.
- P5: 2-5 baseline strategies and canonical signal contract.
- P6: ensemble, cost/edge gate and explainable decision object.
- P7: command center, scanner, signal detail and alerts.
- P8: event-driven backtest with realistic costs and golden run.
- P9: WFO/OOS/stress/Monte Carlo and promotion registry.
- P10: realistic paper broker and reconciliation.
- P11: hard risk controls, portfolio heat, risk states, kill switch.
- P12: performance, calibration, MAE/MFE and attribution analytics.
- P13: admin, observability, audit, strategy/model registry.
- P14: security, load, chaos, CI/CD, backups.
- P15: broker read-only sync only.
- P16: demo execution with idempotency and reconciliation.
- P17: manual approval + tiny live pilot + rollback.
- P18: advanced alpha only after baseline is stable.

## Critical rule
A later prompt may not weaken an earlier acceptance gate. If a prompt conflicts with the frozen blueprint, stop and report the conflict rather than improvising.
