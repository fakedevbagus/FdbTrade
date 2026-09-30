# Offline Private Beta Operator Guide

This guide is for one local operator on a loopback-only machine. It does not
authorize live execution, provider credentials, remote access, automatic paper
runs, demo/live modes, or M48 runtime wiring.

## Before each session

1. Confirm the branch and worktree are expected and clean.
2. Keep the data root private (directory mode 0700; SQLite mode 0600).
3. Run `make upgrade-preflight`.
4. Run `make offline-private-beta-drill`.
5. Continue only when all 12 drill steps and all three soak cycles pass.

## Operator flow

The drill creates a temporary, disposable authority root and verifies:

1. bootstrap and the exact 12-migration ledger;
2. local single-user login and opaque durable session;
3. immutable operator-owned CSV import;
4. signal workbench candidate and evidence;
5. research result and temporal-validation evidence;
6. deterministic paper-input resolution;
7. explicit `confirm-paper-run` paper-only execution;
8. closed outcome and reconciliation;
9. integrity, foreign keys, migration ledger and authority counts;
10. clean shutdown/restart;
11. verified backup; and
12. restore into an empty unpublished root followed by reopen.

The drill deletes its temporary working data when complete. The JSON report
contains identifiers and digests, never a password, token, credential, or
provider payload.

## Incident recovery

- Stop using the affected data root; do not reset or edit SQLite manually.
- Preserve logs and the failed report without adding secrets.
- Run health and upgrade preflight against the original root.
- Select a previously verified backup and restore only into a new empty root.
- Reopen and verify integrity, foreign keys, migration ledger, immutable
  artifacts and workflow authority counts before publication.
- If verification fails, keep the original root untouched and escalate for
  reviewed repair or compensating migration. Never use Git reset as database
  rollback and never partially replace files.

## Honest limitations

- This is an authority-level operator drill, not browser automation.
- Its fixed two-row CSV fixture proves plumbing and durability, not strategy
  quality, profitability, or realistic market coverage.
- Backup authority currently covers SQLite plus registered market-data and
  research-backtest artifacts.
- The product remains private, single-user, loopback-only and offline.
- No provider, scheduler, remote-access, live/demo execution, automatic paper,
  or M48 runtime authority is exercised or granted.