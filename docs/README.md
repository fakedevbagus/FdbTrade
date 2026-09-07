# docs/ — Documentation and ADRs

- `adr/` — Architecture Decision Records (ADR-0001 baseline stack, ADR-0002
  repository layout, ADR-0003 architecture boundaries, ADR-0004 UTC time policy,
  ADR-0005 live trading OFF by default, ADR-0006 CI baseline). See
  `docs/adr/README.md` for the format, numbering, and status lifecycle, and
  `02_TEMPLATES/ADR_TEMPLATE.md` for the template.
- Deeper design/reference docs may land here as phases produce them.

CI: `ci/run-local.sh` is the local deterministic CI runner; `.github/workflows/ci.yml`
defines the hosted CI (see ADR-0006).