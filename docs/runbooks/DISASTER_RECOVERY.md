# Disaster Recovery and Restore Drill (R0.10)

SQLite plus referenced immutable artifacts form one recoverable local set.
There is no PostgreSQL dump, WAL archive, Docker service or remote backup claim.

## Create and verify a backup

Stop application writes for the simplest operator procedure, choose an output
root outside `FDB_DATA_ROOT`, then run:

```bash
export FDB_DATA_ROOT=/absolute/path/to/fdbtrade-data
scripts/backup-db.sh /absolute/path/to/backups
```

The command uses the SQLite online-backup API, derives the artifact set from
that completed snapshot, verifies every digest and publishes
`<backup-root>/<backup-id>/` atomically. `manifest.json` pins the migration
ledger, database hash, artifact hashes and OFF safety flags. Success appends a
`backup_created` event to the source SQLite authority.

## Restore without overwriting state

The target must be an absolute empty directory and must not be the active data
root:

```bash
scripts/restore-db.sh \
  /absolute/path/to/backups/<backup-id> \
  /absolute/path/to/empty-restore-root
```

The command verifies the backup before writing, copies the database and only
the manifest-listed artifacts, runs SQLite integrity and foreign-key checks,
checks all artifact hashes, and records `restore_verified` in the restored
database. Any mismatch removes the incomplete target and exits non-zero.

Inspect the restored root before selecting it as `FDB_DATA_ROOT`. R0.10 never
deletes, renames or overwrites the active root.

## Hermetic deployment/recovery drill

```bash
export FDB_DATA_ROOT=/absolute/path/to/fdbtrade-data
make deployment-drill
```

The drill backs up the current authority, restores it below a temporary
directory, reopens and verifies it, removes the temporary copy, and appends
`deployment_drill_verified` to the source database. It makes no external
network call and does not deploy to a host.

## Fail-closed rules

- Never edit `manifest.json`, a backup database or content-addressed artifact.
- Never restore into a non-empty directory.
- Preserve a failed backup/restore command and its output for diagnosis.
- Keep live execution and provider-order transport OFF.
- A backup without a successful restore drill is not proven recoverable.
