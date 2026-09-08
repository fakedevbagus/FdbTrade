# FdbTrade root task runner (P00-02; db targets added in P01-03)
# Deterministic entry points: install, lint, typecheck, test, build, start, check,
# db-up, db-down, db-migrate, db-status, help.
# All internal timestamps are UTC; no secrets in output.

.PHONY: help install lint typecheck test build start check db-up db-down db-migrate db-status

help:
	@echo "FdbTrade workspace task runner"
	@echo ""
	@echo "Available targets:"
	@echo "  make install     Install workspace dependencies (pnpm)"
	@echo "  make lint        Run linters across all packages (no-op on placeholders)"
	@echo "  make typecheck   Run typecheckers across all packages (no-op on placeholders)"
	@echo "  make test        Run unit tests (pnpm workspace scripts + Python stdlib)"
	@echo "  make build       Build all packages (no-op on placeholders)"
	@echo "  make start       Start local dev servers (no-op on placeholders; P01+)"
	@echo "  make check       Run lint + typecheck + test + build"
	@echo "  make db-up       Start local postgres (Docker) and migrate from zero"
	@echo "  make db-down     Stop local postgres (data volume preserved)"
	@echo "  make db-migrate  Apply pending migrations (requires running postgres)"
	@echo "  make db-status   Show migration ledger status"
	@echo ""
	@echo "Placeholder packages expose no business logic; targets become real in P01+."

install:
	pnpm install

lint:
	pnpm -r --if-present run lint

typecheck:
	pnpm -r --if-present run typecheck

test:
	pnpm -r --if-present run test
	python3 -m unittest discover -s tests -p "test_*.py" -v

build:
	pnpm -r --if-present run build

start:
	pnpm -r --if-present run start

check: lint typecheck test build
	@echo "All workspace checks passed."

db-up:
	bash scripts/db-bootstrap.sh up

db-down:
	bash scripts/db-bootstrap.sh down

db-migrate:
	pnpm --filter @fdbtrade/backend run db:migrate

db-status:
	pnpm --filter @fdbtrade/backend run db:status
