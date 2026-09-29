# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.11 — Local Web Security Hardening**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.12 — Upgrade and Rollback Safety**

Authorization state: **not authorized**

R1.11 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.12 — Upgrade and Rollback Safety sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Revalidate the R1.11 commit, clean worktree, 15/15 gate, twelve migrations and
10/10 M48 hashes. Add executable upgrade failure, rollback and verified recovery
evidence without weakening local security, durable health or trading safety.
```

## Resume checks

1. Verify the R1.11 atomic commit and clean branch.
2. Verify adversarial origin, throttle, rotation, restart, permission and leak tests.
3. Verify 15/15 gate, twelve migrations and 10/10 M48 hashes.

## Stop rule

Do not start R1.12 without its explicit authorization. Do not infer R1.13 or any
later unit from completion of R1.11.
