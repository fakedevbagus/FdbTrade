# ADR-0004: UTC time policy

- Status: Accepted (P00-04)
- Date: 2026-09-07 (UTC)
- Deciders: FdbTrade owner (blueprint approver), implementing agent
- Supersedes: none
- Related: ADR-0001 (baseline stack), ADR-0002 (repository layout item 6),
  `infra/config` (`app.timezone`), `00_CONTROL/AGENT_CONSTITUTION.md`

## Context

The constitution requires "all timestamps are UTC internally". Without a
recorded policy, different layers could store local time, mix zones, or apply
timezone offsets differently, breaking determinism and candle-close semantics.

## Decision

1. **UTC is the single internal timezone.** All stored timestamps, log lines,
   job metadata, bar/candle timestamps, and API timestamps are UTC.
2. **Conversion to a local zone happens only at presentation** (UI display,
   human-facing reports), never in storage or computation.
3. **Config locks the environment to UTC**: `app.timezone` in the config schema
   is `enum allowed=("UTC",)` with default `UTC`; it cannot be set to a local
   zone (enforced by `infra/config`).
4. **Candle-close semantics are explicit and zone-qualified**: any candle/bar
   boundary is defined against UTC and documented at the boundary.
5. **Determinism**: time-dependent logic uses explicit, injectable clocks or
   UTC-derived inputs; no dependence on the host's local timezone.

## Consequences

- No "9am local" surprises across hosts or deployments; reproducible fixtures
  and backtests regardless of machine zone.
- UI must translate UTC to the viewer's zone; the system never stores local time.
- Any future need to store another zone is a superseding ADR, not a local fix.

## Verification

- `infra/config` schema test asserts `app.timezone == "UTC"` and rejects other
  values (`tests/test_config_contracts.py`).
- Code review checklist: timestamps are UTC; local conversion only at
  presentation.