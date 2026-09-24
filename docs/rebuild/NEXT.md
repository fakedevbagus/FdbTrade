# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.3 — Research Workbench UI**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.4 — Temporal Validation Authority**

Authorization state: **not authorized**

R1.3 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.4 — Temporal Validation Authority sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.3/research-workbench-ui.json`
- `docs/rebuild/checkpoints/R1.3_RESEARCH_WORKBENCH_UI.md`
- `docs/adr/ADR-0049-projection-only-research-workbench.md`
- `artifacts/rebuild/r1.2/authoritative-research-api.json`
- `docs/rebuild/checkpoints/R1.2_AUTHORITATIVE_RESEARCH_API.md`
- `docs/adr/ADR-0048-authoritative-research-api.md`
- `artifacts/rebuild/r0.8/research-backtest-authority.json`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt pack standard protocol. Revalidate the R1.3 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, nine ordered migrations, false
safety flags and all ten M48 hashes before editing.

Design and implement a separate SQLite and immutable-artifact authority for
chronological train/validation/test and rolling walk-forward evaluation of the
frozen deterministic baseline. Pin dataset/config/split lineage, embargo
boundaries, costs and deterministic seed. Reject overlapping or future-leaking
splits. Recovery and replay must verify all input and output evidence.

This evidence must remain historical and non-promotional. Do not change R0.7
signals, infer confidence, search parameters, add ML, invoke paper, use network
data, rewire legacy backtests or touch M48.

Include migration count/order and rollback/reapply coverage, temporal-leakage
negative tests, restart/tamper behavior, authority JSON, ADR/checkpoint, and the
next bounded handoff. Run focused checks and final `make toolchain-gate`;
require 15/15 PASS and zero non-pass. Create exactly one atomic commit, report
its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.3 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.3 projection evidence and the R1.2/R0.8 predecessor authorities.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify nine ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.4 without its explicit authorization. Do not infer R1.5 or any
later unit from `continue`, the roadmap, or completion of R1.4.
