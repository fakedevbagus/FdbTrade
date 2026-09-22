# infra/ — Local configuration authority (R0.4)

R0.4 retired the active PostgreSQL, Redis, and Docker Compose assumptions.
Durable application state now lives in the canonical SQLite database under
`FDB_DATA_ROOT` (or repository-local `.fdbtrade` when unset). No database or
cache daemon is required.

## Configuration contract (P00-03)

- `config/` — dependency-free (stdlib) Python config loader: typed schema,
  explicit environments, safe defaults, validation, redaction, and a
  public-safe view for the frontend. Import point for server-side code:
  `from infra.config import load_config`.
- `.env.example` — canonical environment-variable template for **every**
  `FDB_*` variable. Copy to a local git-ignored `.env` (`cp infra/.env.example
  .env`) and fill in real values there. Never commit real secrets.

Smoke-check the contract locally (from the repo root):

    python -m infra.config                 # redacted JSON (safe to log)
    python -m infra.config --public         # frontend-safe public config only
    python -m infra.config --dotenv .env    # merge a local .env file

Security boundaries enforced by this contract: secrets are redacted
(`[REDACTED]`) in any logged/serialized view, the frontend only ever receives
`to_public_dict()` output, and broker live execution defaults OFF with the
adapter locked to `paper`.

There is intentionally no Compose file. Keep real `.env` files untracked.
