# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.14 — Provider Selection Dossier**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.15 — Credential and Egress Boundary**

Authorization state: **not authorized**

Blocker: **blocked pending one named provider**

R1.14 is the current stop boundary. No provider has been selected.

## Decision required

Review `docs/rebuild/PROVIDER_SELECTION_DOSSIER.md`, then authorize exactly one:

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider Twelve Data sesuai prompt pack.
```

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider OANDA v20 sesuai prompt pack.
```

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider Dukascopy Historical Data Export sesuai prompt pack.
```

Or defer:

```text
Tunda pemilihan provider. Jangan mulai R1.15 dan pertahankan sistem offline.
```

## Resume checks

1. Verify the R1.14 documentation-only commit and clean branch.
2. Verify the sourced matrix, explicit unknowns, shortlist and rejection reasons.
3. Verify complete gate, twelve migrations and M48 preservation.
4. Confirm one exact provider name before any R1.15 work.

## Stop rule

Do not start R1.15 without explicit authorization naming exactly one provider.
Do not infer R1.16 or any later unit from completion of R1.14.