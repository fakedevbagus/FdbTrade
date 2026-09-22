# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.6 — Market-data and artifact authority**

Next planned unit: **R0.7 — Signal intelligence authority**

R0.7 is not authorized by the R0.6 commit alone. Start it only after an
explicit user request in a fresh chat.

## Copy-ready next-chat prompt

```text
Lanjutkan rebuild FdbTrade dengan mengerjakan HANYA:

R0.7 — Signal intelligence authority

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Baseline:

- Branch: `rebuild/r0-preserve-current-state`
- Commit: revalidate HEAD from the completed R0.6 atomic commit
- R0.6 gate: revalidate PASS 15/15, zero skip
- SQLite adalah satu-satunya durable-state dan market-data metadata authority
- Market-data artifacts immutable dan content-addressed di bawah FDB_DATA_ROOT
- Market-data scope: tujuh major, hanya 15m/1h/4h
- Live execution OFF
- Provider-order transport OFF
- Credentialed/network provider belum dipilih
- M48 tetap dikarantina dan non-authoritative

Baca terlebih dahulu:

- `artifacts/rebuild/r0.6/market-data-artifact-authority.json`
- `docs/rebuild/checkpoints/R0.6_MARKET_DATA_ARTIFACT_AUTHORITY.md`
- `docs/adr/ADR-0037-local-sqlite-authority.md`
- `docs/adr/ADR-0038-local-application-and-runtime-lifecycle.md`
- `docs/adr/ADR-0039-market-data-and-artifact-authority.md`
- `docs/rebuild/NEXT.md`

Kerjakan hanya signal intelligence authority di atas dataset yang sudah
terverifikasi: lifecycle signal/evidence, deterministic rule-based candidates,
quality/freshness fail-closed, registry/version/provenance, dan recovery/
idempotency evidence yang diperlukan untuk local decision support.

Jangan mengerjakan backtest/research orchestration, risk, paper broker/outcomes,
UI, backup/restore, credentialed provider, live/provider order transport, atau
M48. Jangan memperluas universe/timeframe R0.6.

Gunakan `make toolchain-gate` sebagai acceptance gate dan berhenti setelah satu
commit atomik R0.7.
```

## Entry checks

1. Revalidate branch, HEAD, clean worktree, R0.6 artifact and 15/15 gate.
2. Revalidate all ten M48 hashes before editing.
3. Confirm no local lifecycle is running before tests that bind ports; never
   stop an unmanaged listener.
4. Keep migrations 0004/0005 and ADR-0038/ADR-0039 behavior intact.
5. Keep every test hermetic: no provider credentials, network calls, Docker,
   PostgreSQL or Redis.

## Stop rule

Stop after R0.7 evidence and one atomic commit. Do not roll into research,
risk, paper execution, UI or any later unit.
