# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.1 — Authoritative Signal Workbench**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.2 — Authoritative Research API**

Authorization state: **not authorized**

R1.1 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.2 — Authoritative Research API sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.1/authoritative-signal-workbench-authority.json`
- `docs/rebuild/checkpoints/R1.1_AUTHORITATIVE_SIGNAL_WORKBENCH.md`
- `docs/adr/ADR-0047-authoritative-signal-workbench-projection.md`
- `docs/rebuild/checkpoints/R0.8_RESEARCH_AND_BACKTEST_AUTHORITY.md`
- `artifacts/rebuild/r0.8/research-backtest-authority.json`
- `docs/adr/ADR-0041-research-and-backtest-authority.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt pack standard protocol. Revalidate the R1.1 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, nine ordered migrations, false
safety flags and all ten M48 hashes before editing.

Add authenticated strict POST/GET `/api/research/runs` and GET
`/api/research/runs/{id}` adapters over the existing R0.8
`ResearchBacktestAuthority`. POST accepts only an existing R0.6 dataset
identity and the minimum explicit UTC request data required by R0.8. Before
execution register/verify the frozen baseline, run recovery and fail closed on
corrupt evidence. GET endpoints are SQLite/artifact-backed projections.

Do not rewire or promote the legacy `/api/backtest/runs` route, add parameter
sweeps, change research assumptions, calibrate confidence, invoke risk/paper,
select a provider, add scheduling or touch M48.

Test authentication, strict schema, quality blocking, idempotency, restart
recovery, artifact tamper rejection and R0.7/R0.9 non-mutation. Add authority
docs, run focused checks and final `make toolchain-gate`; require 15/15 PASS
and zero non-pass. Create exactly one atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, the R1.1 atomic commit as
   HEAD and a clean worktree.
2. Verify R1.1 authority/checkpoint/ADR and the R0.8 predecessor authority.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify nine ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.2 without its explicit authorization. Do not infer R1.3 or any
later unit from `continue`, the roadmap, or completion of R1.2.
