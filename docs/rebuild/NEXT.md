# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.8 — Paper and Outcome Workbench**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.9 — Legacy Surface Retirement**

Authorization state: **not authorized**

R1.8 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.9 — Legacy Surface Retirement sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:
- docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md
- artifacts/rebuild/r1.8/paper-and-outcome-workbench.json
- docs/rebuild/checkpoints/R1.8_PAPER_AND_OUTCOME_WORKBENCH.md
- docs/adr/ADR-0054-paper-and-outcome-workbench.md
- frontend/src/app/(app)/paper/workbench/page.tsx
- frontend/src/lib/paper-workbench.ts
- backend/src/paper/paperWorkbenchProjection.ts
- backend/src/app/api/paper/runs/route.ts
- artifacts/toolchain/gate.json
- artifacts/rebuild/r0.1/preservation.json

Apply the prompt-pack standard protocol. Revalidate the R1.8 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, twelve ordered migrations, false
execution/provider safety flags and all ten M48 hashes before editing.

Inventory production-visible scanner, dashboard, signal detail, historical
import and backtest surfaces. Migrate useful projections to R0/R1 authority and
make remaining legacy/fixture endpoints explicitly unavailable or unmistakably
non-authoritative. Enforce exactly the seven pairs and 15m/1h/4h at all public
boundaries.

Do not delete preserved evidence, redesign algorithms, add providers, expand
scope, change authorities or touch M48. Add authority docs, run the full gate,
commit once and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.8 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.8 workbench, R1.7 API, R1.6 resolution and R0.9 authority evidence.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify twelve ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.9 without its explicit authorization. Do not infer R1.10 or any
later unit from `continue`, the roadmap or completion of R1.8.
