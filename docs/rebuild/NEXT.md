# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.11 — Operational Integrity Closure**

Next planned unit: **none authorized**

R0.11 is the current stop boundary. Do not infer authorization for local
workflow orchestration, research expansion, a credentialed provider, M48,
model promotion, live execution, provider-order transport or any wider
universe/timeframe. A future unit requires a new, explicitly bounded user
request after revalidating the R0.11 atomic commit.

## Copy-ready next-chat prompt

```text
Audit the completed FdbTrade R0.11 checkpoint and propose a scope for a future
work unit only; do not implement or commit anything without separate explicit
authorization.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Revalidate first:

- Branch `rebuild/r0-preserve-current-state`
- HEAD from the completed atomic R0.11 commit
- `artifacts/rebuild/r0.11/operational-integrity-closure-authority.json`
- `docs/rebuild/checkpoints/R0.11_OPERATIONAL_INTEGRITY_CLOSURE.md`
- `docs/adr/ADR-0044-crash-consistent-local-recovery.md`
- `artifacts/toolchain/gate.json` is PASS 15/15 with zero skip
- all ten M48 hashes still match the R0.1 preservation manifest

Preserve these boundaries:

- SQLite is the only mutable durable metadata authority; backup directories
  are immutable evidence and unclaimed backups have no invented SQLite event.
- Backup/restore remains local, strictly verified, non-destructive and
  crash-consistent through staged fsync plus atomic rename.
- R0.6 artifacts stay immutable/content-addressed and scope stays exactly the
  seven FX majors at 15m/1h/4h.
- R0.7 signal, R0.8 research and R0.9 risk/paper/outcome authority remain
  binding; risk approval is mandatory before paper execution.
- Kill remains latched and durable; release lands in red. Paper outcomes are
  not signal confidence, live evidence or model-promotion authority.
- The R0.10 UI remains a projection, not authority.
- Live execution OFF; provider-order transport OFF; no credentialed/network
  provider selected; M48 remains quarantined and non-authoritative.

Return an evidence-based audit and a proposed small-unit plan only. Stop before
editing files, running an external integration, or choosing the next phase.
```

## Resume checks

1. Revalidate branch, HEAD and a clean worktree after the R0.11 commit.
2. Revalidate R0.11 evidence and the 15/15 zero-skip gate report.
3. Revalidate all ten M48 files against
   `artifacts/rebuild/r0.1/preservation.json`.
4. Confirm local lifecycle ownership before any test that binds ports; never
   stop an unmanaged listener.
5. Keep all checks hermetic unless a later request explicitly and safely
   authorizes something else.

## Stop rule

There is no implied R0.12. Stop after audit and proposal. Do not implement
workflow orchestration, a provider, M48, model promotion, live execution or
provider-order transport.
