# scripts/ — Dev/ops helper scripts

Conventions:

- Scripts are deterministic for deterministic inputs; never embed secrets; never emit
  local timestamps (UTC instead); prefer the root `Makefile` targets over ad-hoc one-offs..
- No scripts exist yet — first arrivals belong to their owning phase prompts (P00-03 config,
  P01 dev scripts,, P02 ingestion,, etc...).