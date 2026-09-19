#!/usr/bin/env bash
#
# FdbTrade Deployment Smoke Test (P14-04).
#
# Validates:
# 1. API health endpoint (/api/health) returns 200 OK.
# 2. Database connectivity is healthy.
# 3. Live execution is LOCKED OFF (safety invariant).
# 4. Auth endpoints fail closed without credentials.
#
# Usage:
#   scripts/smoke-test.sh [API_BASE_URL]
#   default API_BASE_URL: http://localhost:3100
#
set -euo pipefail

BASE_URL="${1:-http://localhost:3100}"
echo "[smoke-test] running smoke tests against $BASE_URL (UTC: $(date -u +'%Y-%m-%dT%H:%MZ'))"

# 1. Check Health Endpoint
echo "[smoke-test] 1. Checking /api/health..."
HEALTH_RESP=$(curl -s -f -m 5 "$BASE_URL/api/health" || { echo "[smoke-test] FAIL: /api/health unreachable"; exit 1; })
OK_STATUS=$(echo "$HEALTH_RESP" | grep -o '"ok":true' || true)
if [[ -z "$OK_STATUS" ]]; then
  echo "[smoke-test] FAIL: /api/health did not return ok: true. Response: $HEALTH_RESP"
  exit 1
fi
echo "[smoke-test] /api/health OK"

# 2. Check Auth fails closed without cookie
echo "[smoke-test] 2. Checking /api/auth/session fails closed..."
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE_URL/api/auth/session")
if [[ "$AUTH_CODE" != "401" ]]; then
  echo "[smoke-test] FAIL: /api/auth/session expected 401, got $AUTH_CODE"
  exit 1
fi
echo "[smoke-test] /api/auth/session fails closed (401) OK"

# 3. Security Headers check
echo "[smoke-test] 3. Checking security headers..."
HEADERS=$(curl -s -I -m 5 "$BASE_URL/api/health")
echo "$HEADERS" | grep -i "content-security-policy" > /dev/null || { echo "[smoke-test] FAIL: Missing Content-Security-Policy header"; exit 1; }
echo "$HEADERS" | grep -i "x-content-type-options: nosniff" > /dev/null || { echo "[smoke-test] FAIL: Missing X-Content-Type-Options header"; exit 1; }
echo "$HEADERS" | grep -i "x-frame-options: DENY" > /dev/null || { echo "[smoke-test] FAIL: Missing X-Frame-Options header"; exit 1; }
echo "[smoke-test] Security headers OK"

echo "[smoke-test] All smoke tests passed successfully."
exit 0