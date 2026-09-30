# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.16 — Twelve Data Credentialed Read-Only Shadow**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Selected provider: **Twelve Data**

Next planned unit: **R1.17 — Authoritative Provider Ingestion**

Authorization state: **not authorized**

R1.16 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.17 — Authoritative Provider Ingestion untuk
provider Twelve Data sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Connect accepted read-only provider candles to the existing R0.6 ingestion job
and immutable artifact publication path. Require exact scope, closed bars,
provenance/licensing, quality/freshness, bounded pagination/retry and
idempotent recovery. Provider failure must not fall back to fixture or publish
partial authority. Revalidate the R1.16 commit, complete gate, twelve
migrations and M48 preservation first.
```

## Resume checks

1. Verify the R1.16 atomic commit and clean branch.
2. Verify the R1.15 credential/egress boundary and R1.16 comparison remain
   exact, fail-closed and non-authoritative.
3. Verify no provider call was recorded during R1.16.
4. Verify complete gate, twelve migrations and M48 preservation.

## Stop rule

Do not start R1.17 without explicit authorization. Do not infer R1.18 or any
later unit from completion of R1.16.