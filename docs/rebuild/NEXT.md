# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.1 — Preserve current state**

Next authorized unit: **R0.2 — Capability audit**

## Resume context

1. Verify the current branch descends from the R0.1 quarantine commit.
2. Read `artifacts/rebuild/r0.1/preservation.json` and the R0.1 checkpoint.
3. Confirm the preserved M48 file hashes before evaluating or editing them.
4. Audit the repository by observable capability, not milestone labels or test
   counts.
5. Classify each subsystem as `KEEP`, `REPAIR`, `REPLACE`, `DELETE`, or
   `ARCHIVE`, with evidence and dependencies.
6. Do not implement repairs in R0.2.
7. Update the rebuild checkpoint and stop before R0.3.

Safety invariants remain unchanged: live execution is off, provider-order
transport is off, fixture fallback may never impersonate current provider data,
and the quarantined M48 code is not authorized for runtime use.
