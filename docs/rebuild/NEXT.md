# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.18 — Scheduled Analysis and Alerts**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Selected provider: **Twelve Data**

Next planned unit: **R1.19 — Macro Source Selection Dossier**

Authorization state: **not authorized**

R1.18 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi audit HANYA R1.19 — Macro Source Selection Dossier sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Define measurable calendar-data requirements and compare credible sources for
scheduled FX-relevant events: licensing, revisions, timezone semantics,
country/currency mapping, impact, actual/forecast/previous, history, rate
limits, cost, exportability and reliability. Separate sourced facts, inference
and unknown. Do not create credentials, call APIs, select a source, ingest
data, add sentiment/news scraping or alter signals/risk. Produce a shortlist
and a copy-ready prompt requiring one exact source authorization.
```

## Resume checks

1. Verify the R1.18 atomic commit and clean branch.
2. Verify scheduler default OFF and its only work path is R1.17/R0.6 -> R0.7
   -> durable in-app alert.
3. Verify zero paper-table mutations and no order/promotion transport.
4. Verify complete gate, thirteen migrations and M48 preservation.

## Stop rule

Do not start R1.19 without explicit authorization. Do not infer R1.20 or any
later unit from completion of R1.18.