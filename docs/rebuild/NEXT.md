# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.7 — Signal intelligence authority**

Next planned unit: **R0.8 — Research and backtest authority**

R0.8 is not authorized by the R0.7 commit alone. Start it only after an
explicit user request in a fresh chat.

## Copy-ready next-chat prompt

```text
Lanjutkan rebuild FdbTrade dengan mengerjakan HANYA:

R0.8 — Research and backtest authority

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Baseline:

- Branch: `rebuild/r0-preserve-current-state`
- Commit: revalidate HEAD from the completed R0.7 atomic commit
- R0.7 gate: revalidate PASS 15/15, zero skip
- SQLite adalah satu-satunya durable metadata authority
- Market-data artifacts immutable dan content-addressed di bawah FDB_DATA_ROOT
- Signal candidates/evidence berasal hanya dari dataset R0.6 yang terverifikasi
- Market-data/signal scope: tujuh major, hanya 15m/1h/4h
- Live execution OFF
- Provider-order transport OFF
- Credentialed/network provider belum dipilih
- M48 tetap dikarantina dan non-authoritative

Baca terlebih dahulu:

- `artifacts/rebuild/r0.7/signal-intelligence-authority.json`
- `docs/rebuild/checkpoints/R0.7_SIGNAL_INTELLIGENCE_AUTHORITY.md`
- `docs/adr/ADR-0037-local-sqlite-authority.md`
- `docs/adr/ADR-0039-market-data-and-artifact-authority.md`
- `docs/adr/ADR-0040-signal-intelligence-authority.md`
- `docs/rebuild/NEXT.md`

Kerjakan hanya research dan backtest authority yang deterministic/reproducible
di atas dataset dan signal provenance yang sudah authoritative: lifecycle run,
immutable config/result evidence, recovery/idempotency, dan pemisahan tegas
antara hasil empiris dengan confidence signal.

Jangan mengerjakan risk, paper broker/execution/outcomes operasional, UI,
backup/restore, credentialed provider, live/provider order transport, model
promotion, atau M48. Jangan memperluas universe/timeframe R0.6.

Gunakan `make toolchain-gate` sebagai acceptance gate dan berhenti setelah satu
commit atomik R0.8.
```

## Entry checks

1. Revalidate branch, HEAD, clean worktree, R0.7 artifact and 15/15 gate.
2. Revalidate all ten M48 hashes before editing.
3. Confirm no local lifecycle is running before tests that bind ports; never
   stop an unmanaged listener.
4. Keep migrations 0004/0005/0006 and ADR-0038/ADR-0039/ADR-0040 behavior intact.
5. Keep every test hermetic: no provider credentials, network calls, Docker,
   PostgreSQL or Redis.

## Stop rule

Stop after R0.8 evidence and one atomic commit. Do not roll into risk, paper
execution, UI or any later unit.
