# Cline Task Protocol

For every prompt:

### PLAN
- Inspect repository.
- Read active prompt and referenced docs.
- State files expected to change.
- State tests/checks to run.
- Identify blockers.
- Do not modify files.

### ACT
- Implement only active prompt scope.
- Preserve existing user changes.
- Run focused tests after each logical change.
- Run required acceptance checks.
- Update docs/ADR only when within scope.
- Do not enable future-phase behavior.

### COMPLETE
Produce a completion report containing:
- prompt ID and phase
- timestamp
- branch/commit if available
- files changed
- implementation summary
- tests/checks executed
- acceptance criteria with pass/fail
- known limitations/blockers
- risk notes
- exact next prompt

### STOP CONDITIONS
Stop and report instead of improvising when:
- a requirement conflicts with the frozen blueprint;
- an external credential/service is required but unavailable;
- the active task would require later-phase functionality;
- a destructive migration/reset would be needed;
- live execution would need to be enabled;
- a security or data-integrity assumption cannot be verified.
