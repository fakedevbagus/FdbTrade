# ADR-0003: Architecture boundaries

- Status: Accepted (P00-04)
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0002 (repository layout), ADR-0005
  (live trading OFF by default), `00_CONTROL/AGENT_CONSTITUTION.md`,
  `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`

## Context

FdbTrade is a private trading-intelligence OS. The frozen blueprint and the
Agent Constitution require a hard separation between analysis/signaling and
broker order execution, and prohibit LLM/AI components from holding direct order
authority. These constraints must be recorded as a single durable architectural
decision so every later phase preserves them.

## Decision

1. **Hard, unidirectional pipeline boundary**: execution of orders flows only
   through `strategy -> signal -> risk -> execution`. Strategy, feature, UI, and
   LLM/AI code must never call a broker directly.
2. **LLMs/AI have no order authority**: they may explain, summarize, inspect,
   research, rank, or propose; they must never submit broker orders. Order
   submission remains deterministic code behind risk/execution services and
   explicit phase gates.
3. **Typed contracts and schema validation at every boundary**: cross-layer
   exchanges (signals, orders, decisions, config) use typed contracts validated
   at the boundary (per ADR-0002 item 6). The config contract in
   `infra/config/` is the first instance of this pattern.
4. **Live execution is OFF by default and gated**: no component may enable live
   trading implicitly; it is an explicit, separately gated decision (ADR-0005).
5. **Secrets never cross a boundary**: config secrets are redacted in any log or
   serialized output and the frontend only receives public-safe config
   (P00-03 contract).

## Consequences

- Every strategy/feature/UI/LLM component is structurally incapable of direct
  broker access, not merely expected to avoid it.
- Adding any new execution path requires a superseding ADR and the risk gates of
  P11+/P16+/P17+.
- Tests must assert the boundary holds (no broker import/call from disallowed
  layers) as those layers land.

## Verification

- `make check` passes.
- `tests/test_config_contracts.py` enforces public-safe config and redaction.
- Review checklist for each prompt: no broker call from strategy/feature/UI/LLM
  code; order submission only behind risk/execution services.