# Rollback Checklist (P14-05)

## Pre-Rollback Checks
- [ ] 1. Identify the failing commit hash and target stable commit hash.
- [ ] 2. Engage Kill Switch (`/admin/controls` -> Engage Kill Switch) to prevent any orders in flight during rollback.
- [ ] 3. Ensure database backup is executed prior to touching schema:
       `./scripts/backup-db.sh ./backups`

## Step-by-Step Rollback Procedure
1. **Rollback Database Migrations** (if current deployment introduced schema changes):
   ```bash
   pnpm --filter @fdbtrade/backend run db:rollback
   ```
   Verify database status:
   ```bash
   pnpm --filter @fdbtrade/backend run db:status
   ```

2. **Revert Git Working Tree**:
   ```bash
   git checkout <TARGET_STABLE_COMMIT>
   ```

3. **Re-install Dependencies & Validate Clean Room**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   ```

4. **Restart Application Services**:
   ```bash
   pnpm --filter @fdbtrade/backend run build
   # Restart production process supervisor (systemd / docker compose)
   ```

5. **Post-Rollback Smoke Verification**:
   ```bash
   ./scripts/smoke-test.sh http://localhost:3100
   ```

6. **Release Kill Switch**:
   - Only after health check shows status `healthy` across all components.
   - Navigate to `/admin/controls` -> Release Kill Switch with incident note.
