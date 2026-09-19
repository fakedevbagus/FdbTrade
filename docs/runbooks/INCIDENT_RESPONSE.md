# Incident Response Runbook (P14-05)

## Objectives
Provide unambiguous operational procedures for critical failure states:
1. Provider outage or stale market data.
2. Unexpected risk breach or runaway signals.
3. System database or cache failure.

## Severity Levels
- **SEV-1 (Critical)**: Risk limits exceeded, unexpected executions, or broker disconnect during open exposure.
- **SEV-2 (High)**: Provider data feed outage, backtest queue halted, or database write failures.
- **SEV-3 (Medium)**: Degraded health state, high query latency (>200ms P95), or non-critical worker restart.

## Kill Switch Procedure
When an immediate cessation of trading activity is required:
1. **Via UI**: Navigate to `/admin/controls` -> Click "Engage Kill Switch" with reason.
2. **Via API**:
   ```bash
   curl -X POST http://localhost:3100/api/admin/controls \
     -H "Content-Type: application/json" \
     -H "Cookie: fdb_session=<ADMIN_SESSION_COOKIE>" \
     -d '{"action":"engage_kill","reason":"Emergency manual stop"}'
   ```
3. **Verification**:
   - Verify risk state transitions to `red` / `halted`.
   - All signal generation and order dispatch fail closed immediately.
   - Kill switch state is latched and will NEVER auto-reset.

## Outage Procedures
### 1. Market Data Provider Outage
- **Symptoms**: Health dashboard indicates `degraded` or `unhealthy` for provider component.
- **Behavior**: Ingestion workers fail closed; no orders are dispatched with stale context.
- **Action**: Check external provider connectivity and credentials. No manual reset required; system auto-recovers to `healthy` upon 3 consecutive successful fetches.

### 2. Database Disconnection
- **Symptoms**: `/api/health` returns status `degraded` or `fail_safe`. API endpoints return structured 500 or 401.
- **Action**:
  ```bash
  ./scripts/db-bootstrap.sh status
  docker logs fdbtrade-postgres
  ```
  If container stopped, run `./scripts/db-bootstrap.sh up`.
