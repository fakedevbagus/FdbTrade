# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.9 — Legacy Surface Retirement**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.10 — Durable Operational Health**

Authorization state: **not authorized**

R1.9 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.10 — Durable Operational Health sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Revalidate the R1.9 commit, clean worktree, 15/15 gate, twelve migrations and
10/10 M48 hashes. Replace invented/default health with read-only durable facts.
Unknown evidence must degrade or fail closed. Do not add providers, scheduler
work, trading mutations or M48 wiring.
```

## Resume checks

1. Verify the R1.9 atomic commit and clean branch.
2. Verify retired APIs return authenticated 410 and authorities remain available.
3. Verify 15/15 gate, twelve migrations and 10/10 M48 hashes.

## Stop rule

Do not start R1.10 without its explicit authorization. Do not infer R1.11 or any
later unit from completion of R1.9.
