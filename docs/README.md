# docs/ — Documentation and ADRs

- `OPERATOR_GUIDE.md` — private-beta operator guide (M44): install, configure, run,
  monitor, and recover without reading source code.
- `checkpoints/` — per-milestone certified state
  (`43_private_beta.md`, `44_bootstrap.md`).
- `handoff/FRESH_CHAT_RESUME_PROMPT.md` — fresh-session resume protocol.
- `runbooks/` — disaster recovery, incident response, rollback checklist.
- `adr/` — Architecture Decision Records (ADR-0001 baseline stack through
  ADR-0033 reproducible bootstrap and beta onboarding). See
  `docs/adr/README.md` for the format, numbering, and status lifecycle, and
  `02_TEMPLATES/ADR_TEMPLATE.md` for the template.

CI: `ci/run-local.sh` is the local deterministic CI runner; `.github/workflows/ci.yml`
defines the hosted CI (see ADR-0006).