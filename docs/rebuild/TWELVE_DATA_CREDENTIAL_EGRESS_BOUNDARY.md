# R1.15 Twelve Data Credential and Egress Boundary

Status: implemented foundation; no production ingestion

Provider authorized by operator: **Twelve Data**

## Credential contract

- Secret path: `<configDir>/twelve-data.json`.
- Exact JSON shape: `{"apiKey":"..."}` with no additional keys.
- File must be a regular non-symlink owned by the operator with mode `0600`.
- Key stays memory-only. Status and audit surfaces receive only a 16-hex SHA-256
  fingerprint.
- Missing, malformed, over-permissive or wrong-owner secrets fail closed.

No environment-variable, UI, query-string or database credential path exists.

## Exact egress contract

| Field | Only allowed value |
| --- | --- |
| Scheme/origin | `https://api.twelvedata.com` |
| Method | `GET` |
| Path | `/time_series` |
| Query keys | `symbol`, `interval`, `outputsize`, `format`, `timezone` |
| Symbols | `EUR/USD`, `GBP/USD`, `USD/JPY`, `USD/CHF`, `AUD/USD`, `USD/CAD`, `NZD/USD` |
| Intervals | `15min`, `1h`, `4h` |
| Output size | integer 1–5,000 |
| Format/timezone | `JSON`, `UTC` |
| Redirect | rejected |
| Timeout | 5,000 ms |

The API key is carried only in the `Authorization` header. Arbitrary URLs,
verbs, paths, query keys, symbols, intervals and output sizes cannot be supplied
to the transport.

## DNS/IP defense

The caller must inject a resolver. Every resolved address is checked before the
transport port is called. Empty answers, loopback, private, link-local,
carrier-grade NAT, benchmarking, multicast and unspecified addresses fail
closed. This check is in addition to the exact hostname and HTTPS boundary.

## Retry and rate budget

- Maximum two attempts.
- Retry only a transport failure, HTTP 429 or HTTP 5xx.
- Deterministic 250 ms bounded backoff before the second attempt.
- Maximum eight attempts per rolling minute window and 800 per day in the
  in-memory boundary budget.
- HTTP 4xx other than 429 fails without retry.

These values match the evaluated Basic-plan ceiling; they are a maximum, not an
authorization to schedule polling.

## Audit and redaction

One metadata-only event records outcome, stable failure code, attempt count,
fixed path, exact query-key names and optional credential fingerprint. It never
records header values, URL query values, response content, API key or raw error
objects. Error details are bounded and secret-shaped content is redacted.

## Hermetic verification

Tests use injected resolver, HTTP, sleep, clock and audit ports. They prove:

- permission, symlink and exact-secret-shape rejection;
- exact HTTPS/method/path/query policy;
- no key in the URL;
- public-address acceptance and private-address rejection;
- successful bounded retry;
- rate-budget exhaustion;
- metadata-only audit and error redaction.

No test or production code invokes Twelve Data. There is deliberately no real
`fetch`, DNS resolver, scheduler, ingestion worker, UI field or R0.6 publication
wiring in R1.15.

## Stop boundary

R1.16 may add an operator-triggered credentialed read-only shadow only after
fresh authorization. R1.15 does not authorize provider calls or authoritative
ingestion.