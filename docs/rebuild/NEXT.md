# FdbTrade Rebuild — Next Work Unit

Current completed unit: **R1.10 — Durable Operational Health**

Canonical roadmap: `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md`

Next planned unit: **R1.11 — Local Web Security Hardening**

Authorization state: **not authorized**

R1.10 is the current stop boundary.

## Copy-ready next-chat prompt

```text
Otorisasi implementasi HANYA R1.11 — Local Web Security Hardening sesuai
docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md, satu commit atomik, lalu
berhenti.

Revalidate the R1.10 commit, clean worktree, 15/15 gate, twelve migrations and
10/10 M48 hashes. Perform the bounded local threat review and harden mutation
origin/CSRF, login throttling, session rotation/revocation, loopback binding,
file permissions, response headers and redaction. Do not add remote exposure,
cloud identity, provider credentials, trading changes or M48 wiring.
```

## Stop rule

Do not start R1.11 without explicit authorization. Do not infer R1.12.
