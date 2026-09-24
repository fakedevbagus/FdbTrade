# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.2 — Authoritative Research API**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.3 — Research Workbench UI**

Authorization state: **not authorized**

R1.2 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.3 — Research Workbench UI sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.2/authoritative-research-api.json`
- `docs/rebuild/checkpoints/R1.2_AUTHORITATIVE_RESEARCH_API.md`
- `docs/adr/ADR-0048-authoritative-research-api.md`
- `docs/rebuild/checkpoints/R0.8_RESEARCH_AND_BACKTEST_AUTHORITY.md`
- `artifacts/rebuild/r0.8/research-backtest-authority.json`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt pack standard protocol. Revalidate the R1.2 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, nine ordered migrations, false
safety flags and all ten M48 hashes before editing.

Build a projection-only research workflow over R1.2: select an eligible
registered R0.6 dataset, explicitly start one frozen baseline run through POST
`/api/research/runs`, and reopen list/detail evidence through the R1.2 GET
routes. Display lifecycle, metrics, cost assumptions, artifact/source lineage
and the historical-only, uncalibrated, non-promotion interpretation. Handle
empty, loading, quality-blocked, failed, stale-session and backend-unavailable
states truthfully.

Do not add parameter optimization, editable strategy logic, confidence,
automatic promotion, risk/paper execution, provider access, scheduling, legacy
backtest authority or M48 wiring.

Test strict frontend response schemas, exact POST payloads, same-origin
forwarding, eligible dataset selection, success/blocked/failed/replay states and
backend contract preservation. Add authority docs, run focused checks and final
`make toolchain-gate`; require 15/15 PASS and zero non-pass. Create exactly one
atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.2 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.2 authority/checkpoint/ADR and the R0.8 predecessor authority.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify nine ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.3 without its explicit authorization. Do not infer R1.4 or any
later unit from `continue`, the roadmap, or completion of R1.3.
