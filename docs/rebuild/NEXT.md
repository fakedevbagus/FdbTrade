# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.7 — Operator-Confirmed Paper API**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.8 — Paper and Outcome Workbench**

Authorization state: **not authorized**

R1.7 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.8 — Paper and Outcome Workbench sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.7/operator-confirmed-paper-api.json`
- `docs/rebuild/checkpoints/R1.7_OPERATOR_CONFIRMED_PAPER_API.md`
- `docs/adr/ADR-0053-operator-confirmed-paper-api.md`
- `backend/src/app/api/paper/runs/route.ts`
- `backend/src/app/api/paper/runs/[runId]/route.ts`
- `backend/src/paper/riskPaperAuthority.ts`
- `artifacts/rebuild/r1.6/paper-input-resolution-authority.json`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt-pack standard protocol. Revalidate the R1.7 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, twelve ordered migrations, false
execution/provider safety flags and all ten M48 hashes before editing.

Build a projection-only paper and outcome workbench over the R1.7 API. Review
the active authoritative candidate, R1.6 resolved assumptions, quantity and
durable risk state before an explicit confirmation. Project risk verdict,
paper order/fill/position ledger, reconciliation and paper-only outcome. Make
kill/red states and limitations prominent.

Do not add background submission, automatic execution, live/demo language,
browser-side authority, caller-selected costs/conversion, confidence changes,
provider access, scheduling, strategy promotion, legacy-backtest rewiring or
M48 wiring.

Prove explicit confirmation, double-submit replay, kill/release,
blocked/rejected/failed states, refresh after restart, backend unavailability
and projection-only behavior. Add authority JSON, ADR/checkpoint/NEXT, run
focused checks and final `make toolchain-gate`; require 15/15 PASS and zero
non-pass. Create exactly one atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.7 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.7 API, R1.6 resolution and R0.9 risk/paper authority evidence.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify twelve ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.8 without its explicit authorization. Do not infer R1.9 or any
later unit from `continue`, the roadmap or completion of R1.7.
