# FdbTrade Recovery Procedures (R0.4 authority reset)

FdbTrade is a single-user Linux-local application. SQLite at
`<data-root>/fdbtrade.sqlite3` is the only active durable-state authority.
The default data root is repository-local `.fdbtrade`; an explicit
`FDB_DATA_ROOT` must be absolute.

## Quick reference

| Scenario | Safe action |
|---|---|
| Database not initialized | `make db-migrate` then `make db-status` |
| Migration failure | Preserve the database and command output; do not reset it |
| Suspected database corruption | Stop the backend, preserve the database plus `-wal`/`-shm`, escalate |
| Service will not start | `scripts/fdbtrade stop && scripts/fdbtrade start` |
| Port conflict | `scripts/fdbtrade stop`, then inspect `ss -tlnp` |
| Corrupt virtual environment | Recreate `.venv`, then `make bootstrap` |
| Missing `.env` | `cp infra/.env.example .env` |

## SQLite migration recovery

```bash
make db-status
make db-migrate
```

Migrations are checksummed and transactional. A checksum mismatch is a hard
stop: restore the committed migration file or add a new migration; never edit
an applied migration. `make db-rollback` rolls back only the most recent
migration and is not a general data-recovery mechanism.

R0.4 intentionally exposes no destructive database reset and no approved
SQLite backup/restore workflow. The legacy `scripts/backup-db.sh` and
`scripts/restore-db.sh` commands fail closed until a later work unit defines
and drills a truthful recovery authority. Never delete `.fdbtrade`, a custom
data root, or SQLite `-wal`/`-shm` files as an ad-hoc repair.

## Service recovery

```bash
scripts/fdbtrade stop
scripts/fdbtrade start
scripts/fdbtrade status
```

The operator CLI is scoped to the recorded process and loopback port 3100.
Do not use broad process-name kills.

## Dependency recovery

```bash
make bootstrap
make toolchain-gate
```

The bounded R0.3 toolchain is the install/lint/typecheck/test/build authority.
Do not delete local durable state while repairing dependencies.

## Historical and seven-major data

User-owned historical datasets remain private artifacts. Preserve their
manifest and content together. For an unavailable or shed seven-major pair,
re-request the same closed range and honor its explicit failure reason; never
substitute another pair or fixture bars as current provider data.

## Verification after recovery

```bash
make db-status
make toolchain-gate
curl -s http://127.0.0.1:3100/api/health
```

Live execution and provider order transport remain off.
