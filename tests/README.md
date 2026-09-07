# tests/ — Cross-cutting contract tests

Python stdlib `unittest` (no extra dependencies — PyPI is slow per ENVIRONMENT.md..

- `tests/test_skeleton_contracts.py` — P00-02 skeleton contracts (entry points,, placeholder
  package contracts,, idempotent install,, malformed-input rejection..
- `tests/test_config_contracts.py` — P00-03 configuration/environment contract
  (typed loading,, explicit environments,, safe defaults,, validation,, redaction,, public-safe
  view,, `.env` merge, CLI boundary).
- Unit tests specific to a package live with that package from P01 onward; this dir is
  for cross-cutting contracts only..