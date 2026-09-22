# FdbTrade Recovery Procedures (R0.5 local lifecycle)

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
| Service will not start | `scripts/fdbtrade status --json`, then stop only a verified recorded lifecycle |
| Port conflict | Inspect `ss -tlnp`; do not assume the listener belongs to FdbTrade |
| Interrupted scheduler cycle | Start normally after the lock expires; SQLite resumes the verified checkpoint chain |
| Checkpoint integrity degraded | Stop both apps, preserve SQLite plus `-wal`/`-shm`, and escalate |
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

The operator CLI manages frontend `127.0.0.1:3000` and backend
`127.0.0.1:3100` as one lifecycle. Stop signals only process groups whose
recorded PID and Linux start token still match. If lifecycle metadata is
corrupt or missing while a port is occupied, it refuses the kill. Inspect the
owner and resolve it explicitly; do not use broad process-name kills.

Scheduler process locks are expiring SQLite rows. After an abrupt crash, wait
for the stale window and start normally. Recovery verifies the checkpoint hash
chain and resumes only remaining stages; dedupe and completion rows absorb
replay. Never edit runtime rows to force takeover or bypass corruption.

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
