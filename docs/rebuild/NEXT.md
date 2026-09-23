# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.8 — Research and backtest authority**

Next planned unit: **R0.9 — Risk, paper broker and outcomes authority**

R0.9 is not authorized by the R0.8 commit alone. Start it only after an
explicit user request in a fresh chat.

## Copy-ready next-chat prompt

```text
Lanjutkan rebuild FdbTrade dengan mengerjakan HANYA:

R0.9 — Risk, paper broker and outcomes authority

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Baseline:

- Branch: `rebuild/r0-preserve-current-state`
- Commit: revalidate HEAD from the completed R0.8 atomic commit
- R0.8 gate: revalidate PASS 15/15, zero skip
- SQLite adalah satu-satunya durable metadata authority
- Market-data dan research/backtest artifacts immutable/content-addressed di bawah FDB_DATA_ROOT
- Signal candidates berasal hanya dari dataset R0.6 yang terverifikasi
- Hasil backtest bersifat empirical historical evidence, bukan signal confidence atau promotion authority
- Market-data/signal scope: tujuh major, hanya 15m/1h/4h
- Live execution OFF
- Provider-order transport OFF
- Credentialed/network provider belum dipilih
- M48 tetap dikarantina dan non-authoritative

Baca terlebih dahulu:

- `artifacts/rebuild/r0.8/research-backtest-authority.json`
- `docs/rebuild/checkpoints/R0.8_RESEARCH_AND_BACKTEST_AUTHORITY.md`
- `docs/adr/ADR-0037-local-sqlite-authority.md`
- `docs/adr/ADR-0039-market-data-and-artifact-authority.md`
- `docs/adr/ADR-0040-signal-intelligence-authority.md`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `docs/rebuild/NEXT.md`

Kerjakan hanya authority risk, paper broker dan outcomes yang durable dan
fail-closed: mandatory pre-paper risk decision, append-only paper order/fill/
position ledger, reconciliation, latched kill state, outcome attribution,
recovery/idempotency, dan pemisahan tegas dari live/provider order transport.

Jangan mengerjakan UI, backup/restore, credentialed provider, live/provider
order transport, model promotion, atau M48. Jangan memperluas universe/
timeframe R0.6 dan jangan menganggap hasil backtest sebagai confidence signal.

Gunakan `make toolchain-gate` sebagai acceptance gate dan berhenti setelah satu
commit atomik R0.9.
```

## Entry checks

1. Revalidate branch, HEAD, clean worktree, R0.8 artifact and 15/15 gate.
2. Revalidate all ten M48 hashes before editing.
3. Confirm no local lifecycle is running before tests that bind ports; never
   stop an unmanaged listener.
4. Keep migrations 0004/0005/0006/0007 and ADR-0038 through ADR-0041 behavior
   intact.
5. Keep every test hermetic: no provider credentials, network calls, Docker,
   PostgreSQL or Redis.

## Stop rule

Stop after R0.9 evidence and one atomic commit. Do not roll into UI,
backup/restore, credentialed providers, M48 or any later unit.
