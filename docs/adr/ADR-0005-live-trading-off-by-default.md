# ADR-0005: Live trading OFF by default

- Status: Accepted (P00-04)
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0003 (architecture boundaries),
  `infra/config` (broker namespace), `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`

## Context

FdbTrade may eventually bridge a live broker (MT5, P15+). The constitution and
blueprint require live execution to be OFF by default and never enabled simply
because a prompt mentions broker/execution. A durable decision is needed so no
later component defaults to live trading.

## Decision

1. **Live execution is OFF by default.** `broker.live_enabled` defaults `false`
   in config; nothing may flip it on implicitly.
2. **The broker bridge defaults to paper.** `broker.adapter` is locked to
   `paper` in the config schema; a real adapter (e.g. MT5) requires a superseding
   ADR and the P15+ adapter work beginning with fixtures/mocks.
3. **A config flag is not order authority.** `broker.live_enabled=true` merely
   permits the execution path; order submission still requires the hard
   risk/execution boundaries (ADR-0003) and the P11+/P16+/P17+ gates.
4. **No auto-trading from a prompt alone.** Adding live execution requires an
   explicit prompt belonging to P16/P17 with all earlier gates satisfied and
   risk hard limits authoritative.

## Consequences

- Development and testing are safe by default; an operator must deliberately
  and explicitly enable live capability.
- `broker.live_enabled` is surfaced in public-safe config so the UI can reflect
  the live state without exposing secrets.
- Later phases must assert `live_enabled == False` in tests/fixtures until the
  live gate prompt explicitly enables it.

## Verification

- `tests/test_config_contracts.py::test_live_execution_off_by_default` asserts
  the default is `False`.
- `tests/test_config_contracts.py::test_public_view_contains_only_public_fields`
  asserts `broker.live_enabled` is in public-safe config.
- Config schema rejects any `adapter` other than `paper`.