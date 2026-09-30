# Twelve Data Credentialed Read-Only Shadow

R1.16 adds one explicit observation path for the provider selected in R1.14.
It does not add provider authority.

## What the command does

`scripts/twelve_data_shadow.mjs`:

1. reads the owner-only `twelve-data.json` accepted by R1.15;
2. makes one bounded `GET /time_series` request through the exact R1.15
   allowlist and budget;
3. pins TLS to a public DNS result while preserving certificate and hostname
   verification;
4. normalizes the documented Twelve Data `meta`, `values` and `status` shape;
5. rejects malformed OHLC, mismatched metadata, duplicate timestamps,
   off-grid timestamps and oversized evidence;
6. excludes every provider bar whose close instant is later than the declared
   observation instant;
7. compares the remaining rows with a canonical R0.6 candle artifact; and
8. prints coverage, closure, timestamp and pip-drift evidence to stdout.

The official Twelve Data time-series documentation defines `datetime` as the
bar-open time and publishes OHLC fields as strings:
<https://twelvedata.com/docs/llms/market-data/time-series.md>.

## Operator command

No credentialed smoke test was run during R1.16. An operator may run one
separately after creating an owner-only configuration directory and secret:

```bash
node --experimental-strip-types scripts/twelve_data_shadow.mjs \
  --config-dir /absolute/owner-only/config \
  --authority-artifact /absolute/r0.6/reference.candles \
  --pair EUR/USD \
  --interval 1h \
  --outputsize 100 \
  --pip-size 0.0001 \
  --observed-at 2026-09-30T12:30:00.000Z
```

JPY pairs must use the pip size from instrument metadata (normally `0.01`);
the command never guesses a pip size. The reference file must use the canonical
R0.6 pipe-delimited candle representation.

Exit status is `0` only for a completed comparison, `2` for blocked or rejected
evidence, and `64` for invalid command arguments.

## Authority boundary

The report always states:

- `published: false`;
- `mutated: false`;
- `eligibleForSignals: false`;
- `eligibleForResearch: false`; and
- `eligibleForPaper: false`.

There is no SQLite import, R0.6 publication, fixture fallback, API, browser
credential, scheduler, signal evaluation, research run, paper action, broker
method, demo behavior or live behavior.

## M48 provenance decision

All ten quarantined M48 files were verified byte-for-byte against
`artifacts/rebuild/r0.1/preservation.json`. None was reused. Its generic,
operator-declared provider surface does not match the selected Twelve Data
boundary and remains quarantined and non-authoritative.

## Stop boundary

Only a separately authorized R1.17 may connect accepted, closed provider
candles to the R0.6 ingestion and immutable artifact publication path.