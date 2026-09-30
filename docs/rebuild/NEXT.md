# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.17 — Twelve Data Authoritative Provider Ingestion**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Selected provider: **Twelve Data**

Next planned unit: **R1.18 — Scheduled Analysis and Alerts**

Authorization state: **not authorized**

R1.17 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.18 — Scheduled Analysis and Alerts sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Schedule authoritative provider ingestion, R0.7 evaluation and durable in-app
alert creation while preserving single-process lock, leases, checkpoints,
dedupe, bounded backlog, market-session behavior, graceful drain and restart
recovery. Keep the scheduler opt-in and off by default. It must have no R0.9
paper-run call, order authority, model promotion or provider-order transport.
Revalidate R1.17, the complete gate, twelve migrations and M48 preservation.
```

## Resume checks

1. Verify the R1.17 atomic commit and clean branch.
2. Verify R1.17 only publishes complete, closed, fresh, licensed and
   session-complete provider batches through R0.6.
3. Verify no real provider call was recorded during R1.17.
4. Verify complete gate, twelve migrations and M48 preservation.

## Stop rule

Do not start R1.18 without explicit authorization. Do not infer R1.19 or any
later unit from completion of R1.17.