# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.5 — Local application and runtime lifecycle**

Next planned unit: **R0.6 — Market-data and artifact authority**

R0.6 is not authorized by the R0.5 commit alone. Start it only after an
explicit user request in a fresh chat.

## Copy-ready next-chat prompt

```text
Lanjutkan rebuild FdbTrade dengan mengerjakan HANYA:

R0.6 — Market-data and artifact authority

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Baseline:

- Branch: `rebuild/r0-preserve-current-state`
- Commit: revalidate HEAD from the completed R0.5 atomic commit
- R0.5 gate: revalidate PASS 15/15, zero skip
- SQLite adalah satu-satunya durable-state authority
- Local frontend/backend lifecycle authority: `scripts/fdbtrade`
- Runtime locks/leases/checkpoints/completions/dedupe: SQLite migration 0004
- Live execution OFF
- Provider-order transport OFF
- M48 tetap dikarantina dan non-authoritative

Baca terlebih dahulu:

- `artifacts/rebuild/r0.5/local-runtime-lifecycle.json`
- `docs/rebuild/checkpoints/R0.5_LOCAL_APPLICATION_RUNTIME_LIFECYCLE.md`
- `docs/adr/ADR-0037-local-sqlite-authority.md`
- `docs/adr/ADR-0038-local-application-and-runtime-lifecycle.md`
- `docs/rebuild/NEXT.md`

Kerjakan hanya market-data dan artifact authority: fixture/historical ingestion,
registries, tujuh major/timeframe yang disetujui, freshness/quality, immutable
artifact content plus transactional SQLite metadata, atomic publication, dan
hermetic recovery/idempotency evidence.

Jangan mengerjakan signal intelligence, backtest/research orchestration, risk,
paper broker/outcomes, UI, backup/restore, credentialed provider, live/provider
order transport, atau M48.

Gunakan `make toolchain-gate` sebagai acceptance gate dan berhenti setelah satu
commit atomik R0.6.
```

## Entry checks

1. Revalidate branch, HEAD, clean worktree, R0.5 artifact and the 15/15 gate.
2. Revalidate all ten M48 hashes before editing.
3. Confirm no local lifecycle is running before tests that bind ports; never
   stop an unmanaged listener.
4. Keep migration 0004 and ADR-0038 behavior intact.
5. Keep every test hermetic: no provider credentials, network calls, Docker,
   PostgreSQL or Redis.

## Stop rule

Stop after R0.6 evidence and one atomic commit. Do not roll into signal
intelligence or any later unit.
