# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.12 — Operator-Triggered Authoritative Signal Evaluation**

Next planned unit: **none authorized**

R0.12 is the current stop boundary. Do not infer authorization for research or
risk/paper orchestration, automatic scheduling, operational-health expansion,
provider selection, M48, model promotion, live execution, provider-order
transport or a wider universe/timeframe.

## Copy-ready next-chat prompt

```text
Audit the completed FdbTrade R0.12 checkpoint and propose a scope for a future
work unit only. Do not implement or commit without a separate authorization
that explicitly names the selected unit.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Revalidate first:

- Branch `rebuild/r0-preserve-current-state`
- HEAD from the completed atomic R0.12 commit
- clean worktree
- `artifacts/rebuild/r0.12/authoritative-signal-entrypoint-authority.json`
- `docs/rebuild/checkpoints/R0.12_AUTHORITATIVE_SIGNAL_ENTRYPOINT.md`
- `docs/adr/ADR-0045-operator-triggered-authoritative-signal-evaluation.md`
- `artifacts/toolchain/gate.json` is PASS 15/15 with zero skip
- all ten M48 hashes match `artifacts/rebuild/r0.1/preservation.json`

Preserve these boundaries:

- SQLite is the only mutable durable metadata authority.
- R0.6 artifacts remain immutable/content-addressed; scope remains exactly the
  seven FX majors at 15m/1h/4h.
- The R0.12 route only invokes R0.7 signal authority over an existing R0.6
  dataset. Duplicate requests replay the durable result.
- R0.8 research and R0.9 risk/paper/outcome authority remain separate. A
  persisted approved risk decision is still mandatory before paper execution.
- Kill remains latched and durable; release lands in red. Paper outcomes are
  not signal confidence, live evidence or model-promotion authority.
- The scheduler remains observation-only and off by default. The UI remains a
  projection, not authority.
- Backup/restore keeps the R0.11 staged fsync/atomic-rename protocol. Unclaimed
  backups have no invented SQLite event.
- Live execution OFF; provider-order transport OFF; no credentialed/network
  provider selected; M48 remains quarantined and non-authoritative.

Return an evidence-based audit and one small, atomic proposal only. Stop before
editing files, choosing a provider or starting another work unit.
```

## Resume checks

1. Revalidate branch, HEAD, clean worktree and the R0.12 atomic commit.
2. Revalidate R0.12 route behavior and the 15/15 zero-skip gate report.
3. Revalidate nine ordered migrations and all ten M48 files.
4. Confirm local lifecycle ownership before any test that binds ports; never
   stop an unmanaged listener.
5. Keep all checks hermetic unless a later request explicitly authorizes
   otherwise.

## Stop rule

There is no implied R0.13. Stop after audit and proposal. Do not implement a
future unit without an explicit name and scope.
