# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R0.9 — Risk, paper broker and outcomes authority**

Next planned unit: **R0.10 — UI and operational hardening**

R0.10 is not authorized by the R0.9 commit alone. Start it only after an
explicit user request in a fresh chat. Its exact UI, observability,
backup/restore and deployment-drill scope must be confirmed before editing.

## Copy-ready next-chat prompt

```text
Lanjutkan rebuild FdbTrade dengan mengerjakan HANYA:

R0.10 — UI and operational hardening

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Baseline:

- Branch: `rebuild/r0-preserve-current-state`
- Commit: revalidate HEAD from the completed R0.9 atomic commit
- R0.9 gate: revalidate PASS 15/15, zero skip
- SQLite adalah satu-satunya durable metadata authority
- R0.6 artifacts immutable/content-addressed dan scope tetap tujuh major, 15m/1h/4h
- R0.7 signal candidates, R0.8 research evidence dan R0.9 risk/paper/outcome lineage tetap authoritative sesuai ADR masing-masing
- Risk decision wajib sebelum paper execution; kill state tetap latched dan durable
- Outcome paper bukan signal confidence, live evidence, atau model-promotion authority
- Live execution OFF dan provider-order transport OFF
- Credentialed/network provider belum dipilih
- M48 tetap dikarantina dan non-authoritative

Baca terlebih dahulu:

- `artifacts/rebuild/r0.9/risk-paper-outcomes-authority.json`
- `docs/rebuild/checkpoints/R0.9_RISK_PAPER_OUTCOMES_AUTHORITY.md`
- `docs/adr/ADR-0037-local-sqlite-authority.md`
- `docs/adr/ADR-0039-market-data-and-artifact-authority.md`
- `docs/adr/ADR-0040-signal-intelligence-authority.md`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `docs/adr/ADR-0042-risk-paper-and-outcomes-authority.md`
- `docs/rebuild/NEXT.md`

Tentukan scope R0.10 secara eksplisit sebelum implementasi. Jangan mengerjakan
credentialed provider, live/provider order transport, model promotion, atau
M48. Jangan melemahkan authority/gate R0.4-R0.9 dan jangan memperluas universe
atau timeframe R0.6.

Gunakan `make toolchain-gate` sebagai acceptance gate dan berhenti setelah satu
commit atomik R0.10.
```

## Entry checks

1. Revalidate branch, HEAD, clean worktree, R0.9 artifact and 15/15 gate.
2. Revalidate all ten M48 hashes before editing.
3. Confirm no local lifecycle is running before tests that bind ports; never
   stop an unmanaged listener.
4. Preserve migrations 0004 through 0008 and ADR-0038 through ADR-0042.
5. Keep tests hermetic: no provider credentials, external network, Docker,
   PostgreSQL or Redis.

## Stop rule

Stop after the explicitly authorized R0.10 scope and one atomic commit. Do not
roll into credentialed providers, M48 or live/provider-order execution.
