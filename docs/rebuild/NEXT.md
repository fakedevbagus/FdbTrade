# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.0 — Blueprint Authority and Prompt Pack**

Canonical roadmap:
`docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.1 — Authoritative Signal Workbench**

Authorization state: **not authorized**

R1.0 is the current stop boundary. The prompt pack describes future units but
does not grant standing implementation authority.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.1 — Authoritative Signal Workbench sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Repository:
`/media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade`

Read first:

- `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`
- `artifacts/rebuild/r1.0/blueprint-authority.json`
- `docs/rebuild/checkpoints/R1.0_BLUEPRINT_AUTHORITY_AND_PROMPT_PACK.md`
- `docs/adr/ADR-0046-r1-roadmap-and-promptpack-governance.md`
- `docs/rebuild/checkpoints/R0.12_AUTHORITATIVE_SIGNAL_ENTRYPOINT.md`
- `artifacts/rebuild/r0.12/authoritative-signal-entrypoint-authority.json`
- `docs/adr/ADR-0045-operator-triggered-authoritative-signal-evaluation.md`
- `artifacts/toolchain/gate.json`
- `artifacts/rebuild/r0.1/preservation.json`

Apply the prompt pack standard protocol. Revalidate the R1.0 atomic commit as
HEAD, clean worktree, 15/15 zero-skip gate, nine ordered migrations, false
safety flags and all ten M48 hashes before editing.

Build an authenticated read projection for R0.7 evaluation runs/candidates and
an operator UI that selects an existing R0.6 dataset, submits the existing
R0.12 endpoint and displays candidate, wait, blocked or failed evidence with
dataset/rule/timestamp lineage. SQLite remains authority; UI remains projection.

Do not invoke R0.8/R0.9, change the signal rule, use the legacy scanner as
authority, add scheduling, select/call a provider, wire M48, add model
promotion, expand scope or enable demo/live/provider-order execution.

Test strict route behavior, list/detail ordering, empty/error states, duplicate
replay, file-backed reopen and cross-authority non-mutation. Add the required
ADR if needed, authority artifact, checkpoint and NEXT handoff. Run focused
checks and final `make toolchain-gate`; require 15/15 PASS and zero non-pass.
Create exactly one atomic commit, report its hash and stop.
```

## Resume checks

1. Verify branch `rebuild/r0-preserve-current-state`, R1.0 commit as HEAD and a
   clean worktree.
2. Verify the R1.0 authority/checkpoint/ADR and canonical prompt pack.
3. Verify `artifacts/toolchain/gate.json` is PASS 15/15 with zero non-pass.
4. Verify nine ordered migrations and 10/10 M48 hashes.
5. Confirm local lifecycle ownership before tests that bind ports.

## Stop rule

Do not start R1.1 without its explicit authorization. Do not infer R1.2 or any
later unit from `continue`, the roadmap, or completion of R1.1.
