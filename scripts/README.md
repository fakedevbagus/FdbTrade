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
scripts/fdbtrade start    # frontend :3000 + backend :3100, loopback only
scripts/fdbtrade status --json
scripts/fdbtrade stop     # recorded PID + process-start token only, never by name/port
scripts/fdbtrade recover
```

Operator documentation: `docs/OPERATOR_GUIDE.md`. Recovery procedures: `RECOVERY.md`.

## Other scripts

| Script | Purpose |
| --- | --- |
| `db-bootstrap.sh` | SQLite migration/status compatibility wrapper |
| `backup-db.sh` / `restore-db.sh` | R0.10 SQLite plus referenced-artifact backup and non-destructive verified restore |
| `operational-data.mjs` | Hermetic backup, restore and deployment-drill authority |
| `deploy-staging.sh` | Compatibility name for the local R0.10 deployment/recovery drill; no external deployment |
| `smoke-test.sh` | Post-deploy smoke checks |
