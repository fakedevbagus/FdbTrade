# FdbTrade Recovery Procedures (M43/M44/M45)

This document provides recovery procedures for the FdbTrade private beta. All procedures assume the standard Linux environment documented in `ENVIRONMENT.md`.

## Quick Reference

| Scenario | Procedure | RTO | RPO |
|---|---|---|---|
| Database corruption | `scripts/restore-db.sh <backup> --confirm` | < 15 min | < 24 h |
| Service won't start | `scripts/fdbtrade stop && scripts/fdbtrade start` | < 2 min | 0 |
| Port conflict | `scripts/fdbtrade stop` then check `ss -tlnp` | < 1 min | 0 |
| Corrupt venv | `rm -rf .venv && make bootstrap` | < 5 min | 0 |
| Missing .env | `cp infra/.env.example .env && make db-up` | < 2 min | 0 |
| Git working tree dirty | `git status && git stash` | < 30 sec | 0 |

## 1. Database Recovery

### 1.1 Automated Backup Restore

```bash
# List available backups
ls -la backups/

# Restore specific backup (checksum verified)
scripts/restore-db.sh backups/fdbtrade_fdbtrade_20260919T120000Z.sql.gz --confirm
```

### 1.2 PostgreSQL Container Recovery

```bash
# If container is unhealthy
make db-down
docker volume rm fdbtrade_pgdata  # WARNING: destroys data
make db-up
```

### 1.3 Schema Migration Issues

```bash
# Check migration status
make db-status

# If stuck, rollback last migration
make db-migrate  # or pnpm --filter @fdbtrade/backend run db:rollback

# Re-apply
make db-migrate
```

## 2. Service Recovery

### 2.1 Full Service Restart

```bash
# Graceful stop
scripts/fdbtrade stop

# Force stop if needed
pkill -f "next-server"  # backend
pkill -f "next dev"     # frontend (if running)

# Clean restart
scripts/fdbtrade start
```

### 2.2 Port Conflicts

```bash
# Check what's using ports
ss -tlnp | grep -E '3000|3100|15432'

# Kill specific process
kill -9 <PID>

# Or use fdbtrade stop which handles this
scripts/fdbtrade stop
```

## 3. Environment Recovery

### 3.1 Missing or Corrupt .env

```bash
# Recreate from template (generates new random DB password)
cp infra/.env.example .env
make db-up
```

### 3.2 Python Virtual Environment

```bash
# Remove and recreate
rm -rf .venv
make bootstrap
```

### 3.3 Node Dependencies

```bash
# Clean reinstall
rm -rf node_modules frontend/node_modules backend/node_modules contracts/node_modules
pnpm install
```

## 4. Git State Recovery

```bash
# Check status
git status

# Stash local changes
git stash

# Reset to clean HEAD if needed (DANGER: loses uncommitted work)
# git reset --hard HEAD

# Apply stashed changes
git stash pop
```

## 5. Complete Clean Slate (Nuclear Option)

```bash
# WARNING: destroys all local data including database
make db-down
docker volume rm fdbtrade_pgdata 2>/dev/null || true
rm -rf .venv node_modules frontend/node_modules backend/node_modules contracts/node_modules
rm -f .env
git clean -fdX  # removes all ignored files
make bootstrap
```

## 6. Verification After Recovery

```bash
# Run all checks
make check

# Health endpoint
curl -s http://127.0.0.1:3100/api/health | jq .

# Dashboard (requires auth)
# scripts/fdbtrade status
```

## 7. Emergency Contacts & Escalation

- Primary: Local operator (single-user product)
- Logs: `journalctl -u docker` for Docker issues
- Database logs: `docker logs fdbtrade-postgres`

---
*Generated from M43 private-beta state. Updated for M44 bootstrap implementation.*