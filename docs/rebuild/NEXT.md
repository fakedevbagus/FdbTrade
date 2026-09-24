# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.4 — Temporal Validation Authority**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.5 — Robustness and Selection-Bias Evidence**

Authorization state: **not authorized**

R1.4 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.5 — Robustness and Selection-Bias Evidence
sesuai docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik,
lalu berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.4/temporal-validation-authority.json`
- `docs/rebuild/checkpoints/R1.4_TEMPORAL_VALIDATION_AUTHORITY.md`
- `docs/adr/ADR-0050-temporal-validation-authority.md`
- `backend/src/research/temporalValidationAuthority.ts`
- `backend/db/sqlite-migrations/0010_temporal_validation_authority.sql`
- `artifacts/rebuild/r0.8/research-backtest-authority.json`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt pack standard protocol. Revalidate the R1.4 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, ten ordered migrations, false
safety flags and all ten M48 hashes before editing.

Extend only the R1.4 research-evidence layer with bounded, predeclared
cost/slippage stress, sensitivity ranges, minimum-sample requirements,
regime/timeframe breakdown and a durable experiment ledger that prevents
silently selecting only favorable trials. Produce explicit pass,
insufficient-evidence or rejected conclusions with limitations.

Do not tune or change R0.7 production rules, create automatic promotion, treat
research as signal confidence, add ML/provider/paper behavior, rewire legacy
backtests or touch M48.

Include migration count/order and rollback/reapply coverage, sparse/unstable/
adverse-cost and duplicate-experiment tests, restart/tamper behavior, authority
JSON, ADR/checkpoint, and the next bounded handoff. Run focused checks and final
`make toolchain-gate`; require 15/15 PASS and zero non-pass. Create exactly one
atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.4 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.4 temporal evidence and the R0.8/R0.6 predecessor authorities.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify ten ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.5 without its explicit authorization. Do not infer R1.6 or any
later unit from `continue`, the roadmap, or completion of R1.5.
