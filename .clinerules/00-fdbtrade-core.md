# FdbTrade — Cline Core Rules

You are implementing FdbTrade, a private trading-intelligence application. The frozen blueprint is the source of truth.

## Execution discipline
- Work only on the active prompt's stated scope.
- Before editing: inspect the repository and identify the exact files relevant to the task.
- Do not rewrite unrelated files, rename broad areas, or replace architecture without an ADR.
- Never silently change the approved stack or dependency manager.
- Use pnpm for JS/TS and Python 3.12/venv or Docker for Python work unless an ADR says otherwise.
- Work on the current repository state; do not reset or discard user changes.
- Prefer small, reversible changes.
- Run the narrowest relevant tests after each implementation unit, then the broader required checks before completion.
- Every production bug must get a regression test.
- Never invent credentials, endpoints, or provider access.
- Use fixture/mock adapters when external credentials or services are unavailable.

## Trading safety
- Live execution is OFF by default.
- Strategy code must never call a broker directly.
- Strategy -> signal -> risk -> execution is a hard boundary.
- Risk hard limits are authoritative and cannot be bypassed by strategy or AI/LLM components.
- LLM/AI may explain, rank, research, or propose; it must never have direct broker-order authority.
- Do not add auto-trading merely because a prompt mentions broker/execution; follow the phase and exact scope.
- Never treat confidence as guaranteed win probability.
- Never implement claims of guaranteed profit or guaranteed accuracy.

## Quant integrity
- No look-ahead bias, leakage, future-derived labels, or hidden test-set optimization.
- Candle-close semantics must be explicit.
- Transaction costs, spread, slippage, and latency assumptions are mandatory where applicable.
- Reproducibility requires dataset/version/parameter/code provenance.
- New strategies require deterministic fixtures and tests.
- Do not optimize parameters before the backtest harness and validation gates are stable.

## Filesystem constraints from the inspected environment
- Workspace is on NTFS via fuseblk; do not depend on Unix permission bits or symlinks.
- Git must remain compatible with core.fileMode=false and core.autocrlf=false.
- PyPI is reachable but slow; avoid unnecessary reinstall loops and prefer Docker/vendored wheels where practical.
- MT5 terminal is absent on the development Linux host; use fixtures/mocks until a real terminal exists.
- Existing Docker containers belonging to unrelated projects must not be modified.

## Documentation and completion
- Keep ADRs and relevant docs synchronized with implementation.
- At task completion, report files changed, tests run, acceptance results, limitations/blockers, and the exact next prompt.
- If a required acceptance criterion cannot be verified, say so explicitly; never mark it passed by assumption.
