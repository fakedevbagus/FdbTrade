# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.6 — Paper Input Resolution**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.7 — Operator-Confirmed Paper API**

Authorization state: **not authorized**

R1.6 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.7 — Operator-Confirmed Paper API sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.6/paper-input-resolution-authority.json`
- `docs/rebuild/checkpoints/R1.6_PAPER_INPUT_RESOLUTION.md`
- `docs/adr/ADR-0052-paper-input-resolution-authority.md`
- `backend/src/paper/paperInputResolutionAuthority.ts`
- `backend/src/paper/riskPaperAuthority.ts`
- `backend/db/sqlite-migrations/0012_paper_input_resolution.sql`
- `artifacts/rebuild/r0.9/risk-paper-outcomes-authority.json`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt-pack standard protocol. Revalidate the R1.6 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, twelve ordered migrations, false
safety flags and all ten M48 hashes before editing.

Add authenticated strict POST/GET `/api/paper/runs` and GET
`/api/paper/runs/{id}` adapters over R0.9 using only R1.6-resolved conversion
and cost inputs. One POST is the explicit operator confirmation. Run recovery
and reconciliation before new work; a persisted approved risk decision must
precede paper submit, fill and outcome events. Return blocked, rejected and
failed states truthfully.

Do not add automatic execution, accept caller-supplied authoritative costs or
conversion, bypass risk, add provider/network calls or orders, enable demo/live
transport, change R0.7 rules, promote research, rewire legacy backtests or
touch M48.

Prove auth, strict unknown-field rejection, explicit confirmation, kill/release
behavior, rejected decisions without fills, idempotency, divergent replay
rejection, restart recovery, ledger reconciliation, resolution tamper/staleness
blocking and cross-authority integrity. Add authority JSON, ADR/checkpoint/NEXT,
run focused checks and final `make toolchain-gate`; require 15/15 PASS and zero
non-pass. Create exactly one atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.6 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.6 resolution evidence and R0.9 risk/paper predecessor authority.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify twelve ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.7 without its explicit authorization. Do not infer R1.8 or any
later unit from `continue`, the roadmap or completion of R1.6.
