# infra/ — Deployment/dev infrastructure (P00-03)

Docker Compose (postgres:16, redis:7), env templates, and networking land here
from P00-03 (configuration/environment contract) and P01-03 (PostgreSQL
initialization).

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

Placeholder only — no compose files, no real `.env` yet (do not create real
`.env` files; use `.env.example` patterns from P00-03).