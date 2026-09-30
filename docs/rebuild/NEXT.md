# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.12 — Upgrade and Rollback Safety**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.13 — Offline Private Beta Gate**

Authorization state: **not authorized**

R1.12 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.13 — Offline Private Beta Gate sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Revalidate the R1.12 commit, clean worktree, 15/15 gate, twelve migrations and
10/10 M48 hashes. Exercise the complete offline decision-to-paper operator drill
without provider, scheduler, external network or live execution authority.
```

## Resume checks

1. Verify the R1.12 atomic commit and clean branch.
2. Verify preflight, failure isolation, restore/migrate/reopen and rollback policy.
3. Verify 15/15 gate, twelve migrations and 10/10 M48 hashes.

## Stop rule

Do not start R1.13 without its explicit authorization. Do not infer R1.14 or any
later unit from completion of R1.12.
