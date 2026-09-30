# ADR-0061: Twelve Data credential and egress boundary

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: unbounded provider credential and URL handling
- Related: ADR-0005, ADR-0029, ADR-0043, ADR-0057, ADR-0060
- Work unit: R1.15

## Context

The operator selected Twelve Data after R1.14. Before any provider observation,
the application needs a fail-closed credential and egress foundation that
cannot submit writes, leak the key or widen to arbitrary network destinations.

## Decision

Add a provider-specific, unwired TypeScript boundary with:

1. owner-only `0600` JSON secret loading and fingerprint-only status;
2. exact HTTPS origin, GET path and query allowlists;
3. seven-pair and three-interval validation;
4. injected DNS resolution with private/reserved IP rejection;
5. 5-second timeout metadata, redirect refusal, two attempts, deterministic
   retry and Basic-plan minute/day budgets;
6. metadata-only redacted audit failures; and
7. injected hermetic ports with no production HTTP adapter.

## Consequences

R1.16 can add an operator-triggered read-only shadow without redesigning the
security boundary. R1.15 itself cannot contact Twelve Data, publish R0.6 data,
schedule work or expose a browser credential.

## Verification

Focused behavior tests cover secret permissions, symlinks, request allowlists,
DNS/IP denial, bounded retries, budgets and redaction. Python contracts verify
no production wiring, unchanged migrations and M48 preservation. The complete
gate must pass before the authority artifact is recorded.