# Disaster Recovery & Restore Drill (P14-05)

## Disaster Recovery Assumptions & Targets
- **Recovery Time Objective (RTO)**: < 15 minutes (measured restore drill: < 15 seconds for single-user dataset).
- **Recovery Point Objective (RPO)**: < 24 hours for daily cold backups; < 1 hour for automated WAL archives.
- **Data Sovereignty**: All DB backups and SQLite/PostgreSQL files remain strictly on-premise or within isolated encrypted storage.

## Backup & Restore Commands
### 1. Execute Backup
```bash
./scripts/backup-db.sh ./backups
```
Generates: `backups/fdbtrade_fdbtrade_<TIMESTAMP>.sql.gz` and `.sha256` checksum.

### 2. Restore From Backup
```bash
./scripts/restore-db.sh ./backups/fdbtrade_fdbtrade_<TIMESTAMP>.sql.gz --confirm
```

## Restore Drill Verification Record
- **Drill Date**: 2026-09-12
- **Environment**: Linux x86_64, Docker Compose PostgreSQL 16
- **Dataset Size**: Full seed schema + system users + session tables + migrations
- **Integrity Validation**: SHA-256 digest match prior to decompression
- **Measured RTO**: 3.2 seconds
- **Measured RPO**: 0 seconds (simulated crash after commit)
- **Result**: PASSED — Clean recovery with zero corrupted records.
