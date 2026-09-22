# scripts/ — Dev/ops helper scripts

Conventions:

- Scripts are deterministic for deterministic inputs; never embed secrets; never emit
  local timestamps (UTC instead); prefer the root `Makefile` targets over ad-hoc one-offs.
- Trade/execution safety: scripts must never bind a public interface (loopback only),
  never call a broker, and never enable live execution or provider order transport.

## Operator entry points (M44)

| Script | Purpose |
| --- | --- |
| `bootstrap.sh` | Reproducible install: validates prerequisites, creates/validates `.venv`, installs locked deps, creates `.env` from the template. `--dry-run` mutates nothing. |
| `fdbtrade` | Operator CLI: `preflight` (`--json`), `init` (`--dry-run`), `start`, `stop`, `status`, `check`, `recover`. |

Usage:

```bash
make bootstrap            # or: bash scripts/bootstrap.sh [--dry-run]
make preflight            # or: python3 scripts/fdbtrade preflight --json
scripts/fdbtrade start    # backend on 127.0.0.1:3100 only
scripts/fdbtrade status
scripts/fdbtrade stop     # scoped to the recorded PID / port 3100, never by name
scripts/fdbtrade recover
```

Operator documentation: `docs/OPERATOR_GUIDE.md`. Recovery procedures: `RECOVERY.md`.

## Other scripts

| Script | Purpose |
| --- | --- |
| `db-bootstrap.sh` | SQLite migration/status compatibility wrapper |
| `backup-db.sh` / `restore-db.sh` | Database backup and verified restore |
| `deploy-staging.sh` | Staging deployment helper |
| `smoke-test.sh` | Post-deploy smoke checks |
