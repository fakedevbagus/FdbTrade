# FdbTrade Operator Guide — Private Beta (M44)

Audience: the single Linux operator of this private beta. You do **not** need to
read the source code.

Release: `2.0.0-private-beta`
Execution authority: fixture/offline, historical replay and deterministic local
paper simulation **only**.

> FdbTrade is not a live-money trading system, not a public service, and not a
> profitability product. It never binds a public network interface.
> `LIVE_EXECUTION_ENABLED=false` and `PROVIDER_ORDER_TRANSPORT_ENABLED=false`
> always.

## 1. Prerequisites

| Tool | Required | Checked by |
| --- | --- | --- |
| Python 3.12 | yes | `make preflight` |
| Node.js 24 | yes | `make preflight` |
| pnpm 11 | yes | `make preflight` |
| GNU Make 4.3 | yes | `make preflight` |
| Bash 5 | yes | `make preflight` |
| `sqlite3` CLI binary | optional (warning) | `make preflight` |

## 2. Install (first run)

```bash
git clone <your repo> FdbTrade
cd FdbTrade
make bootstrap          # preflight, then create .venv + install locked deps
make preflight          # re-verify and print the full report
```

`make bootstrap` does exactly four things and nothing else:

1. Validates that required tools exist **before** changing anything.
2. Creates or validates `.venv`.
3. Installs the locked dependencies (`pnpm install --frozen-lockfile`; the Python
   side is stdlib-only, so there is nothing to pip-install).
4. Creates `.env` from `infra/.env.example` if it is missing.

It never asks for, generates, prints, or stores a secret. See ADR-0033 for why
this repository uses `pnpm install --frozen-lockfile` where the blueprint says
`npm ci`.

Safe preview — changes nothing:

```bash
bash scripts/bootstrap.sh --dry-run
```

## 3. Historical research (M46)

Open `/research/datasets` after signing in. Paste only user-owned canonical CSV with exact header:

```text
timestamp,open,high,low,close,volume
```

Use UTC timestamps with millisecond precision. Preview before approval. Approval writes immutable local research artifacts to `artifacts/historical-datasets/`; keep this directory in private backups and never edit files inside it. Duplicate or malformed rows are reported; malformed, ambiguous, or oversized input is rejected. Historical mode is shown separately from fixture and future shadow modes.

For reproducible backtest, select approved dataset ID. Stored report export is `GET /api/backtest/runs/{runId}` while authenticated. Same dataset checksum, code/config, strategy version, and seed reproduce same report identity. FdbTrade never replaces a requested historical dataset with fixture data.

## 4. Database

```bash
make db-up        # compatibility alias: initialize/migrate local SQLite
make db-status    # migration ledger status
make db-migrate   # apply pending migrations
make db-rollback  # roll back the most recent migration
make db-provision # provision or rotate the single local user
```

SQLite is the only active runtime store. It defaults to
`.fdbtrade/fdbtrade.sqlite3`; `FDB_DATA_ROOT` may select an absolute local
directory. PostgreSQL, Redis, Docker, database ports, and database credentials
are not required.

## 5. Start, stop, inspect

```bash
scripts/fdbtrade start          # frontend :3000 + backend :3100, loopback only
scripts/fdbtrade status         # both apps plus SQLite-backed runtime health
scripts/fdbtrade status --json  # the same facts as machine-readable JSON
scripts/fdbtrade stop           # stop only the recorded process groups
```

`start` requires an initialized database (`make db-migrate`) and both ports to
be free. It has a 60-second readiness bound and cleans up its own partial start.
`stop` requires the recorded PID and Linux process-start token to match before
signalling a process group. It never kills by process name or assumes that a
listener on either port belongs to FdbTrade.

The file under `<data-root>/run/lifecycle.json` is non-authoritative process
ownership metadata. Durable scheduler locks, leases, checkpoints, completions,
dedupe and recovery state live only in SQLite. The observation scheduler stays
off unless `FDB_RUNTIME_SCHEDULER=on` and a bounded
`FDB_RUNTIME_INTERVAL_MS=1000..3600000` are set.

Machine-readable environment report:

```bash
scripts/fdbtrade preflight --json
```

The authenticated `/operations` page is the authoritative UI projection. It
reads SQLite metadata for R0.6–R0.10 and exposes no signal, order, provider or
promotion mutation. `/admin/controls` writes only the durable R0.9 risk latch.

## 6. Verify the installation

```bash
make check                              # lint + typecheck + test + build
make operational-packaging-check         # bootstrap/CLI packaging contracts
make private-beta-check                  # live OFF, provider transport OFF, loopback only
make dashboard-check                     # dashboard + health endpoints
make security-check                      # .env ignored, no tracked secrets
make phase2-check                        # Phase 2 authority files
make handoff-check                       # handoff/operator docs present
make format-check                        # syntax + deterministic formatting
```

## 7. What the preflight report means

| Key | Meaning |
| --- | --- |
| `python`, `node`, `npm`, `pnpm`, `make`, `bash` | Detected versions |
| `sqlite3` | CLI binary (`not found` is a warning, not a failure) |
| `python_sqlite` | Python stdlib `sqlite3` module version (required) |
| `disk` | Free space; below 5 GB raises a warning |
| `permissions` | Repository writability |
| `ports` | Loopback availability for 3000 and 3100 |

`preflight` exits `1` only for hard errors. Warnings are printed and do not block.

## 8. Recovery

In-app guidance:

```bash
scripts/fdbtrade recover
```

| Scenario | Command | RTO |
| --- | --- | --- |
| Corrupt `.venv` | `rm -rf .venv && make bootstrap` | < 5 min |
| Missing `.env` | `cp infra/.env.example .env` | < 2 min |
| Port conflict | `scripts/fdbtrade stop` then `ss -tlnp` | < 1 min |
| Service won't start | `scripts/fdbtrade stop && scripts/fdbtrade start` | < 2 min |
| Database corruption | Stop; restore a verified backup into a new empty root | measured by drill |
| Dependency drift | `pnpm install --frozen-lockfile` | < 5 min |

Full procedures, RPO expectations, and the clean-slate path: `RECOVERY.md`.

Create a complete SQLite/artifact backup and prove recovery:

```bash
export FDB_DATA_ROOT=/absolute/path/to/data
make backup BACKUP_ROOT=/absolute/path/to/backups
make deployment-drill
```

See `docs/runbooks/DISASTER_RECOVERY.md`. Restore never overwrites an active
data root.

## 9. What is unavailable or gated in this beta

- No live-money order or trade route exists.
- No broker order credential is used, stored, or requested.
- Provider access, if ever enabled, is read-only market-data shadow only.
- There is no silent fallback from provider data to fixture-looking current data.
- Missing, stale, inconsistent, unavailable, or unverified safety data fails closed.
- Continuous scheduling, historical CSV import, seven-major coverage, credentialed
  provider shadow, remote access, and research-validity work are later milestones
  (M45–M52), not part of M44.

## 10. Where things live

| Path | Purpose |
| --- | --- |
| `Makefile` | All supported entry points (`make help`) |
| `scripts/bootstrap.sh` | Reproducible install |
| `scripts/fdbtrade` | Operator CLI |
| `RECOVERY.md` | Recovery procedures |
| `docs/checkpoints/43_private_beta.md` | Certified state at M43 |
| `docs/handoff/FRESH_CHAT_RESUME_PROMPT.md` | Session resume protocol |
| `docs/adr/ADR-0033-*.md` | Bootstrap and onboarding decision |
| `artifacts/private-beta/acceptance.json` | Acceptance evidence |
