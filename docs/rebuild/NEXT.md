# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.5 — Robustness and Selection-Bias Evidence**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.6 — Paper Input Resolution**

Authorization state: **not authorized**

R1.5 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.6 — Paper Input Resolution sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.5/robustness-selection-bias-authority.json`
- `docs/rebuild/checkpoints/R1.5_ROBUSTNESS_SELECTION_BIAS_EVIDENCE.md`
- `docs/adr/ADR-0051-robustness-and-selection-bias-evidence.md`
- `backend/src/research/robustnessSelectionAuthority.ts`
- `backend/db/sqlite-migrations/0011_robustness_selection_bias_authority.sql`
- `artifacts/rebuild/r0.9/risk-paper-outcomes-authority.json`
- `docs/adr/ADR-0042-risk-paper-and-outcomes-authority.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt-pack standard protocol. Revalidate the R1.5 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, eleven ordered migrations, false
safety flags and all ten M48 hashes before editing.

Add deterministic verified resolution for every R0.9 paper-run input that must
not be trusted from a UI: USD conversion lineage for all seven pairs and
registered baseline spread/slippage assumptions until a provider authority
exists. Stale, missing, ambiguous or corrupt inputs must block explicitly.

Do not add a provider/network call, accept arbitrary UI conversion/cost values,
weaken approved-risk requirements, automate paper execution, enable demo/live
or provider-order transport, change R0.7 rules, promote research, rewire legacy
backtests or touch M48.

Include seven-pair conversion-direction/cross tests, stale/missing/tamper and
restart behavior, migration count/order plus rollback/reapply, authority JSON,
ADR/checkpoint and the next bounded handoff. Run focused checks and final
`make toolchain-gate`; require 15/15 PASS and zero non-pass. Create exactly one
atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.5 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.5 robustness evidence and the R0.9/R0.6 predecessor authorities.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify eleven ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.6 without its explicit authorization. Do not infer R1.7 or any
later unit from `continue`, the roadmap, or completion of R1.6.
