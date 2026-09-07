# OWNERS — CODEOWNERS-style ownership placeholders (P00-02)

Single-user product: the owner placeholder is `@fdbtrade-owner` (the blueprint approver..
Real `.github/CODEOWNERS` wire-up arrives with the hosting/CI decision (P00-04..

| Path | Owners |
|---|---|
| `/` (governance: README, CONTRIBUTING, OWNERS, Makefile, package.json, workspace) | `@fdbtrade-owner` |
| `/frontend/**` | `@fdbtrade-owner` |
| `/backend/**` | `@fdbtrade-owner` |
| `/contracts/**` | `@fdbtrade-owner` |
| `/quant/**` | `@fdbtrade-owner` |
| `/scripts/**` | `@fdbtrade-owner` |
| `/tests/**` | `@fdbtrade-owner` |
| `/docs/**` | `@fdbtrade-owner` |
| `/infra/**` | `@fdbtrade-owner` |
| `/00_CONTROL/**`, `/01_PROMPTS/**`, `/02_TEMPLATES/**`, `/03_REFERENCE/**`, `/04_CLINE_CONTROL/**` | `@fdbtrade-owner` |

Rules:

- Changes touching an area need the owning party's review (single user; effectively self-review..
- The owner placeholder may be replaced by real handles when the repo gains external collaborators..