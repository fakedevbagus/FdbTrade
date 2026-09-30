# FdbTrade root task runner (M44-extended)
# Deterministic entry points. All internal timestamps are UTC; no secrets in output.

.PHONY: help install lint typecheck test build start check toolchain-gate db-up db-down db-migrate db-rollback db-status db-provision backup deployment-drill upgrade-preflight upgrade-drill bootstrap preflight operational-packaging-check private-beta-check dashboard-check security-check phase2-check handoff-check format-check runtime-check operational-persistence-check integration-replay-check historical-research-check seven-majors-check

TOOLCHAIN := python3 scripts/rebuild_toolchain.py
TOOLCHAIN_REPORT_DIR := artifacts/toolchain

help:
	@echo "FdbTrade workspace task runner"
	@echo ""
	@echo "Available targets:"
	@echo "  make install     Install workspace dependencies (pnpm)"
	@echo "  make lint        Run linters across all packages"
	@echo "  make typecheck   Run typecheckers across all packages"
	@echo "  make test        Run unit tests (pnpm workspace scripts + Python stdlib)"
	@echo "  make build       Build all packages"
	@echo "  make start       Start local dev servers"
	@echo "  make check       Aggregate local gate: lint + typecheck + test + build"
	@echo "  make toolchain-gate  Frozen install + complete bounded R0.3 gate"
	@echo "  make db-up       Compatibility alias: initialize/migrate local SQLite"
	@echo "  make db-down     Report that SQLite has no background daemon"
	@echo "  make db-migrate  Apply pending SQLite migrations"
	@echo "  make db-rollback Roll back the most recent SQLite migration"
	@echo "  make db-status   Show migration ledger status"
	@echo "  make db-provision Provision/rotate the private local user"
	@echo "  make backup BACKUP_ROOT=/absolute/path  Verified SQLite/artifact backup"
	@echo "  make deployment-drill  Hermetic backup/restore/reopen drill"
	@echo "  make upgrade-preflight Verify version/schema/artifacts/disk before upgrade"
	@echo "  make upgrade-drill     Backup/restore/migrate/failure/reopen safety drill"
	@echo "  make bootstrap   Reproducible bootstrap (M44): preflight + init"
	@echo "  make preflight   Dependency preflight (M44)"
	@echo "  make operational-packaging-check (M44)"
	@echo "  make private-beta-check (M44)"
	@echo "  make dashboard-check (M44)"
	@echo "  make security-check (M44)"
	@echo "  make phase2-check (M44)"
	@echo "  make handoff-check (M44)"
	@echo "  make format-check (M44)"
	@echo "  make runtime-check (M45)"
	@echo "  make operational-persistence-check (M45)"
	@echo "  make integration-replay-check (M45)"
	@echo "  make historical-research-check (M46)"
	@echo "  make seven-majors-check (M47)"
	@echo ""
	@echo "Operator guide: docs/OPERATOR_GUIDE.md | Checkpoints: docs/checkpoints/"
	@echo ""
	@echo "Live execution OFF | Provider order transport OFF | Loopback-only"

install:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/install.json install

lint:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/lint.json stage lint

typecheck:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/typecheck.json stage typecheck

test:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/test.json stage test

build:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/build.json stage build

start:
	python3 scripts/fdbtrade start

check:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/check.json check

toolchain-gate:
	$(TOOLCHAIN) --output $(TOOLCHAIN_REPORT_DIR)/gate.json gate

db-up:
	bash scripts/db-bootstrap.sh up

db-down:
	bash scripts/db-bootstrap.sh down

db-migrate:
	corepack pnpm --filter @fdbtrade/backend run db:migrate

db-rollback:
	corepack pnpm --filter @fdbtrade/backend run db:rollback

db-status:
	corepack pnpm --filter @fdbtrade/backend run db:status

db-provision:
	corepack pnpm --filter @fdbtrade/backend run db:provision-user

backup:
	@test -n "$(BACKUP_ROOT)" || { echo "BACKUP_ROOT must be an absolute path" >&2; exit 2; }
	bash scripts/backup-db.sh "$(BACKUP_ROOT)"

deployment-drill:
	bash scripts/deploy-staging.sh

upgrade-preflight:
	node scripts/operational-data.mjs upgrade-preflight

upgrade-drill:
	node scripts/operational-data.mjs upgrade-drill

# M44 — Reproducible bootstrap and beta onboarding

bootstrap: preflight
	bash scripts/bootstrap.sh

preflight:
	python3 scripts/fdbtrade preflight

operational-packaging-check:
	@echo "[operational-packaging-check] Verifying operational packaging (M44)..."
	@test -f scripts/fdbtrade && echo "OK: scripts/fdbtrade exists" || (echo "FAIL: scripts/fdbtrade missing" && exit 1)
	@test -f scripts/bootstrap.sh && echo "OK: scripts/bootstrap.sh exists" || (echo "FAIL: scripts/bootstrap.sh missing" && exit 1)
	@test -f requirements.txt && echo "OK: requirements.txt exists" || (echo "FAIL: requirements.txt missing" && exit 1)
	@test -f Makefile && grep -q "^bootstrap:" Makefile && echo "OK: make bootstrap target exists" || (echo "FAIL: make bootstrap target missing" && exit 1)
	@bash -n scripts/bootstrap.sh && echo "OK: bootstrap.sh syntax valid" || (echo "FAIL: bootstrap.sh syntax invalid" && exit 1)
	@bash scripts/bootstrap.sh --dry-run >/dev/null 2>&1 && echo "OK: bootstrap --dry-run exits 0" || (echo "FAIL: bootstrap --dry-run failed" && exit 1)
	@bash scripts/bootstrap.sh --bogus >/dev/null 2>&1 && { echo "FAIL: unknown bootstrap option accepted"; exit 1; } || echo "OK: unknown bootstrap option rejected"
	@bash scripts/bootstrap.sh --dry-run 2>&1 | sed 's/^\[[^]]*\] //' > /tmp/fdbtrade-bootstrap-a.txt; \
	 bash scripts/bootstrap.sh --dry-run 2>&1 | sed 's/^\[[^]]*\] //' > /tmp/fdbtrade-bootstrap-b.txt; \
	 if diff -q /tmp/fdbtrade-bootstrap-a.txt /tmp/fdbtrade-bootstrap-b.txt >/dev/null; then \
		echo "OK: bootstrap --dry-run is deterministic and idempotent"; \
	 else \
		echo "FAIL: bootstrap --dry-run is not idempotent"; rm -f /tmp/fdbtrade-bootstrap-a.txt /tmp/fdbtrade-bootstrap-b.txt; exit 1; \
	 fi; \
	 rm -f /tmp/fdbtrade-bootstrap-a.txt /tmp/fdbtrade-bootstrap-b.txt
	@python3 scripts/fdbtrade --help >/dev/null 2>&1 && echo "OK: fdbtrade --help exits 0" || (echo "FAIL: fdbtrade --help failed" && exit 1)
	@python3 scripts/fdbtrade preflight --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); req={'python','node','npm','pnpm','make','bash','sqlite3','python_sqlite','disk','permissions','ports'}; missing=sorted(req-set(d['checks'])); sys.exit(('FAIL: preflight missing keys: %s' % missing) if missing else 0)" && echo "OK: preflight --json reports every required key" || (echo "FAIL: preflight --json contract violated" && exit 1)
	@test -f docs/checkpoints/43_private_beta.md && echo "OK: checkpoint exists" || (echo "FAIL: checkpoint missing" && exit 1)
	@test -f RECOVERY.md && echo "OK: RECOVERY.md exists" || (echo "FAIL: RECOVERY.md missing" && exit 1)
	@test -f docs/OPERATOR_GUIDE.md && echo "OK: operator guide exists" || (echo "FAIL: operator guide missing" && exit 1)
	@echo "[operational-packaging-check] PASS"

private-beta-check:
	@echo "[private-beta-check] Verifying private beta invariants (M44)..."
	@# Test fixtures under __tests__/*.test.ts build deliberately-invalid payloads
	@# (e.g. liveExecutionEnabled: <true>) to prove the guards REJECT them. Those
	@# are evidence FOR the invariant, so fixture files are excluded from the scan
	@# while every production source, config, and doc stays in scope.
	@if grep -rEl "LIVE_EXECUTION_ENABLED[[:space:]]*=[[:space:]]*true|LIVE_EXECUTION_ENABLED[[:space:]]*=[[:space:]]*\"true\"|liveExecutionEnabled[[:space:]]*:[[:space:]]*true" . \
		--include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.py" --include="*.md" --include="*.yaml" --include="*.yml" --include="*.sh" \
		--exclude="*.test.ts" --exclude="*.test.tsx" --exclude="*.test.js" --exclude="*.spec.ts" --exclude="*.spec.tsx" --exclude-dir=artifacts \
		--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.venv --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=__tests__ --exclude-dir=__mocks__ 2>/dev/null; then \
		echo "FAIL: live execution enabled somewhere"; exit 1; \
	else echo "OK: live execution is never enabled in production sources"; fi
	@if grep -rEl "PROVIDER_ORDER_TRANSPORT_ENABLED[[:space:]]*=[[:space:]]*true|PROVIDER_ORDER_TRANSPORT_ENABLED[[:space:]]*=[[:space:]]*\"true\"|providerOrderTransportEnabled[[:space:]]*:[[:space:]]*true" . \
		--include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.py" --include="*.md" --include="*.yaml" --include="*.yml" --include="*.sh" \
		--exclude="*.test.ts" --exclude="*.test.tsx" --exclude="*.test.js" --exclude="*.spec.ts" --exclude="*.spec.tsx" --exclude-dir=artifacts \
		--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.venv --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=__tests__ --exclude-dir=__mocks__ 2>/dev/null; then \
		echo "FAIL: provider order transport enabled somewhere"; exit 1; \
	else echo "OK: provider order transport is never enabled in production sources"; fi
	@if grep -nE "LIVE_EXECUTION_ENABLED[[:space:]]*=[[:space:]]*true|PROVIDER_ORDER_TRANSPORT_ENABLED[[:space:]]*=[[:space:]]*true" infra/.env.example 2>/dev/null; then \
		echo "FAIL: infra/.env.example enables a live/transport flag"; exit 1; \
	else echo "OK: infra/.env.example keeps both flags off"; fi
	@python3 scripts/fdbtrade preflight --json 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin)['safety']; assert s['liveExecutionEnabled'] is False; assert s['providerOrderTransportEnabled'] is False; assert s['loopbackOnly'] is True" && echo "OK: CLI safety flags are false/false/loopback-only" || (echo "FAIL: CLI safety flags wrong" && exit 1)
	@if grep -nE "(0\.0\.0\.0)" scripts/bootstrap.sh scripts/fdbtrade 2>/dev/null; then echo "FAIL: non-loopback bind address found in M44 scripts"; exit 1; else echo "OK: M44 scripts bind loopback only"; fi
	@echo "[private-beta-check] PASS"

dashboard-check:
	@echo "[dashboard-check] Verifying dashboard and health endpoints (M44)..."
	@test -f backend/src/app/api/dashboard/route.ts && echo "OK: dashboard route exists" || (echo "FAIL: dashboard route missing" && exit 1)
	@test -f backend/src/app/api/health/route.ts && echo "OK: health route exists" || (echo "FAIL: health route missing" && exit 1)
	@grep -q "export const GET" backend/src/app/api/dashboard/route.ts && echo "OK: dashboard route exposes GET" || (echo "FAIL: dashboard route has no GET handler" && exit 1)
	@grep -q "export const GET" backend/src/app/api/health/route.ts && echo "OK: health route exposes GET" || (echo "FAIL: health route has no GET handler" && exit 1)
	@python3 -c "import pathlib,sys; root=pathlib.Path('frontend/src/app'); pages=sorted(root.rglob('page.tsx')) if root.exists() else []; sys.exit(0 if pages else 1)" && echo "OK: frontend pages present" || (echo "FAIL: no frontend pages found" && exit 1)
	@echo "[dashboard-check] PASS"

security-check:
	@echo "[security-check] Verifying security invariants (M44)..."
	@test -f .gitignore && grep -q "^\.env" .gitignore && echo "OK: .env is gitignored" || (echo "FAIL: .env not gitignored" && exit 1)
	@if git ls-files | grep -qE "(^|/)\.env$$"; then echo "FAIL: a real .env file is tracked by git"; exit 1; else echo "OK: no real .env file is tracked"; fi
	@if grep -rniE "(api[_-]?key|secret|password|token)[[:space:]]*=[[:space:]]*[\"'][^\"']+[\"']" scripts/bootstrap.sh scripts/fdbtrade 2>/dev/null; then \
		echo "FAIL: possible hard-coded secret in M44 scripts"; exit 1; \
	else echo "OK: no hard-coded secrets in M44 scripts"; fi
	@if grep -nE "(cat|less|more)[[:space:]]+[^|]*\.env" scripts/bootstrap.sh scripts/fdbtrade 2>/dev/null; then echo "FAIL: M44 scripts may print .env contents"; exit 1; else echo "OK: M44 scripts never print .env contents"; fi
	@echo "[security-check] PASS"

phase2-check:
	@echo "[phase2-check] Verifying Phase 2 authority files (M44)..."
	@test -f PHASE2_PROGRESS_MANIFEST.json && echo "OK: manifest exists" || (echo "FAIL: manifest missing" && exit 1)
	@python3 -c "import json,sys; d=json.load(open('PHASE2_PROGRESS_MANIFEST.json')); missing=[k for k in ('currentMilestone','nextPendingMilestone','targetRelease') if k not in d]; sys.exit(1) if missing else 0" && echo "OK: manifest is valid JSON with milestone keys" || (echo "FAIL: manifest missing milestone keys" && exit 1)
	@test -f docs/checkpoints/43_private_beta.md && echo "OK: checkpoint exists" || (echo "FAIL: checkpoint missing" && exit 1)
	@test -f phase2/PHASE2_ACCEPTANCE_CRITERIA.md && echo "OK: acceptance criteria exists" || (echo "FAIL: acceptance criteria missing" && exit 1)
	@test -f phase2/PHASE2_ARCHITECTURE.md && echo "OK: architecture exists" || (echo "FAIL: architecture missing" && exit 1)
	@test -f phase2/PHASE2_RISK_REGISTER.md && echo "OK: risk register exists" || (echo "FAIL: risk register missing" && exit 1)
	@test -f artifacts/private-beta/acceptance.json && echo "OK: acceptance evidence exists" || (echo "FAIL: acceptance evidence missing" && exit 1)
	@git check-ignore -q artifacts/private-beta/acceptance.json && { echo "FAIL: acceptance evidence is gitignored and cannot be versioned"; exit 1; } || echo "OK: acceptance evidence is committable"
	@echo "[phase2-check] PASS"

handoff-check:
	@echo "[handoff-check] Verifying handoff documentation (M44)..."
	@test -f docs/handoff/FRESH_CHAT_RESUME_PROMPT.md && echo "OK: handoff prompt exists" || (echo "FAIL: handoff prompt missing" && exit 1)
	@for needle in "Resume Protocol" "M44" "M45" "RECOVERY.md" "PHASE2_PROGRESS_MANIFEST.json"; do \
		grep -q "$$needle" docs/handoff/FRESH_CHAT_RESUME_PROMPT.md || { echo "FAIL: handoff prompt missing '$$needle'"; exit 1; }; \
	done
	@echo "OK: handoff prompt documents resume protocol, next milestone, and authority files"
	@test -f docs/OPERATOR_GUIDE.md && echo "OK: operator guide exists" || (echo "FAIL: operator guide missing" && exit 1)
	@echo "[handoff-check] PASS"

format-check:
	@echo "[format-check] Verifying deterministic formatting and syntax (M44)..."
	@test -f scripts/fdbtrade && python3 -m py_compile scripts/fdbtrade && echo "OK: fdbtrade syntax valid" || (echo "FAIL: fdbtrade syntax invalid" && exit 1)
	@for f in scripts/*.sh; do \
		if [ -f "$$f" ]; then \
			bash -n "$$f" && echo "OK: $$f syntax valid" || (echo "FAIL: $$f syntax invalid" && exit 1); \
		fi; \
	done
	@if grep -qE "^''" requirements.txt; then echo "FAIL: requirements.txt contains a placeholder line"; exit 1; else echo "OK: requirements.txt has no placeholder lines"; fi
	@python3 -c "import pathlib,re,sys; bad=[p.name for p in pathlib.Path('scripts').glob('*') if p.is_file() and not re.match(r'^[A-Za-z0-9._-]+$$', p.name)]; sys.exit('FAIL: non-portable script filenames: %s' % bad if bad else 0)" && echo "OK: script filenames portable" || (echo "FAIL: script filenames not portable" && exit 1)
	@echo "[format-check] PASS"

# M45 — Continuous scheduler and runtime hardening

runtime-check:
	@echo "[runtime-check] Verifying continuous scheduler and runtime hardening (M45)..."
	@pnpm --filter @fdbtrade/backend test src/runtime/__tests__/runtime.test.ts
	@python3 -m unittest tests.test_m45_runtime_contracts
	@echo "[runtime-check] PASS"

operational-persistence-check:
	@echo "[operational-persistence-check] Verifying operational persistence and schema migrations (M45)..."
	@python3 -m unittest tests.test_db_foundation_contracts
	@test -d backend/db/migrations && echo "OK: migrations directory exists" || (echo "FAIL: migrations dir missing" && exit 1)
	@test -f backend/db/migrations/0001_foundation.sql && echo "OK: foundation migration exists" || (echo "FAIL: foundation migration missing" && exit 1)
	@test -f backend/db/migrations/0002_auth_foundation.sql && echo "OK: auth foundation migration exists" || (echo "FAIL: auth migration missing" && exit 1)
	@echo "[operational-persistence-check] PASS"

integration-replay-check:
	@echo "[integration-replay-check] Verifying offline fixture replay and backtest engine (M45)..."
	@pnpm --filter @fdbtrade/backend test src/backtest/__tests__ src/data/providers/__tests__
	@echo "[integration-replay-check] PASS"

# M46 — User-facing historical research workflow
historical-research-check:
	@echo "[historical-research-check] Verifying immutable user-owned CSV workflow (M46)..."
	@pnpm --filter @fdbtrade/backend test src/data/historical/__tests__/historical.test.ts src/backtest/__tests__/api.test.ts
	@python3 -m unittest tests.test_m46_historical_contracts
	@echo "[historical-research-check] PASS"

# M47 — Seven-major runtime coverage

seven-majors-check:
	@echo "[seven-majors-check] Verifying seven-major runtime coverage (M47)..."
	@pnpm --filter @fdbtrade/backend test src/runtime/__tests__/sevenMajors.test.ts src/signals/__tests__/pipeline.test.ts src/app/api/dashboard/__tests__/route.test.ts
	@pnpm --filter @fdbtrade/frontend test src/lib/__tests__/dashboard.test.ts src/components/dashboard/__tests__/DashboardContent.test.tsx
	@python3 -m unittest tests.test_m47_seven_major_contracts
	@echo "[seven-majors-check] PASS"
