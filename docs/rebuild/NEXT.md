# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.15 — Twelve Data Credential and Egress Boundary**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Selected provider: **Twelve Data**

Next planned unit: **R1.16 — Credentialed Read-Only Shadow**

Authorization state: **not authorized**

R1.15 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.16 — Credentialed Read-Only Shadow untuk
provider Twelve Data sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Revalidate the R1.15 commit, exact read-only egress boundary, hermetic tests,
complete gate, twelve migrations and M48 preservation. Do not perform a real
credentialed smoke test unless separately requested by the operator.
```

## Resume checks

1. Verify the R1.15 atomic commit and clean branch.
2. Verify secret permissions, exact request allowlist, DNS/IP defense,
   timeout/retry/rate budget and audit redaction.
3. Verify no provider call or R0.6 publication was added.
4. Verify complete gate, twelve migrations and M48 preservation.

## Stop rule

Do not start R1.16 without explicit authorization. Do not infer R1.17 or any
later unit from completion of R1.15.