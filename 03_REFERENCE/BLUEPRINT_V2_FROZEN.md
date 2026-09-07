# FdbTrade Blueprint v2 - Frozen Source of Truth

Status: APPROVED for implementation by user on 7 September 2026.

## Product definition
FdbTrade is a private, single-user trading intelligence OS. The highest priorities are:
1. Signal quality
2. Backtest/research
3. Automation/risk
4. UI
5. Monetization (lowest priority; private use)

## Locked decisions
- Private single-user product.
- FdbTrade brand.
- Provider-agnostic market-data layer.
- TradingView is not the non-display core source for algorithmic decisioning.
- Live execution is OFF by default.
- Risk engine is independent of strategy logic.
- MT5/broker adapter pattern.
- Free-first architecture with upgradeable provider interfaces.
- Full AI/ML scope is allowed, but LLMs must never have direct order authority.
- Prompt pack is serial, small-batch, acceptance-gated.

## North-star loop
Market data -> context -> regime -> feature snapshot -> strategy candidates -> ensemble -> probabilistic forecast -> cost/edge gate -> risk -> execution plan -> paper/demo/live -> outcome -> analytics -> research update.

## Initial trading universe
Core: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD.
Secondary: XAUUSD.
Timeframes: 5m, 15m, 1h, 4h, with 1D context.
Initial research pilot risk placeholder: 0.25-0.50% equity per trade.
Initial portfolio heat cap: 2-3%.
Initial daily loss stop: 1.5-2.0%.
Execution progression: Alert -> Paper -> Demo -> Tiny live.
ML production status: disabled until champion gate is passed.

## Roadmap
P0 Constitution
P1 Foundation
P2 Data Core
P3 Feature Core
P4 Regime Engine
P5 Strategy Core
P6 Alpha Ensemble
P7 Signal UX
P8 Backtest Engine
P9 Research Lab
P10 Paper Broker
P11 Risk Engine
P12 Analytics
P13 Admin/Observability
P14 Hardening
P15 Broker Read-only
P16 Demo Execution
P17 Live Gate
P18 Advanced Alpha

## Global non-negotiables
- No profit guarantee or fake certainty.
- No look-ahead, future leakage, or hidden optimization against final test sets.
- Every signal has strategy/version/input snapshot lineage.
- Every order intent passes independent risk checks.
- Execution must be idempotent and reconcilable.
- External outages/stale data fail closed for new entries.
- Never put secrets in frontend code or logs.
- Never enable live trading by default.
- Every production bug gets a regression test.
- Read existing code before writing.
- Do not rewrite unrelated files.
- Do not change the approved stack without an ADR and explicit approval.
