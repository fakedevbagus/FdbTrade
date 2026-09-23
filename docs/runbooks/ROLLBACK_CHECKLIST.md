# Local Rollback Checklist (R0.10)

Rollback is a deliberate operator procedure. It never enables live execution,
uses a provider transport or overwrites the active SQLite root.

## Before changing code or schema

- [ ] Record the current branch and commit.
- [ ] Engage the durable kill latch at `/admin/controls` when initialized.
- [ ] Stop the local application with `scripts/fdbtrade stop`.
- [ ] Create a verified backup outside the data root:

  ```bash
  make backup BACKUP_ROOT=/absolute/path/to/backups
  ```

- [ ] Run `make deployment-drill`; do not continue if restore verification fails.

## Restore state

Restore the selected backup into a new absolute empty directory:

```bash
scripts/restore-db.sh \
  /absolute/path/to/backups/<backup-id> \
  /absolute/path/to/empty-restore-root
```

Inspect the restored migration ledger and `/operations` view after starting
with `FDB_DATA_ROOT` pointed at that new root. Keep the original root intact
until the restored instance is accepted.

## Verify

```bash
make db-status
make toolchain-gate
scripts/fdbtrade status --json
```

Release from kill only after review. Release lands in `red`; a separate
explicit durable override is required before entries can be approved.
