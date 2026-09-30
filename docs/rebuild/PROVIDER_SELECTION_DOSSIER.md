# R1.14 Provider Selection Dossier

Status: decision-ready; no provider selected

Evidence date: 2026-09-30

Scope: read-only FX candles for `EURUSD`, `GBPUSD`, `USDJPY`, `USDCHF`,
`AUDUSD`, `USDCAD` and `NZDUSD` at 15m, 1h and 4h.

## Guardrails

This dossier does not create an account, credential or API request; enable
egress; select a provider; alter production behavior; or wire M48. A future
R1.15 requires the operator to approve exactly one named provider.

## Measurable requirements

| ID | Requirement | Acceptance measure | Weight |
| --- | --- | --- | ---: |
| R1 | Pair and interval coverage | All seven pairs; native or deterministically aggregatable 15m/1h/4h | 15 |
| R2 | Candle semantics | Documented OHLC source, completeness, timezone/alignment and volume meaning | 10 |
| R3 | History and pagination | Documented range, stable pagination and at least 5,000 bars per bounded page or export | 10 |
| R4 | Freshness and revision behavior | Observable timestamp/completeness plus a documented or testable revision policy | 15 |
| R5 | License and exportability | Personal internal research and durable local export explicitly permitted | 10 |
| R6 | Cost, limits and uptime | Sustainable free/user-owned tier; published limits; outage handling possible | 10 |
| R7 | Authentication safety | No credential preferred; otherwise revocable token and enforceable read-only endpoint allowlist | 10 |
| R8 | SDK independence | Plain HTTP or file export; no vendor SDK required | 10 |
| R9 | Testability | Offline fixtures, deterministic normalization and replay are practical | 10 |

Hard blockers are missing seven-pair coverage, inability to produce 15m/1h/4h,
unclear permission for private durable use, or a transport that cannot be
constrained to reads.

## Fact, inference and unknown convention

- **Fact** means the statement is supported by a cited provider-controlled page.
- **Inference** means an engineering conclusion drawn from those facts.
- **Unknown** means R1.14 found no adequate provider-controlled statement. It
  must be resolved by terms review, account inspection or a later authorized
  read-only probe—not by assumption.

## Decision matrix

Scores are comparative planning aids, not a provider selection.

| Option | Coverage /15 | Semantics /10 | History /10 | Freshness /15 | License /10 | Cost/limits /10 | Auth /10 | SDK-free /10 | Test /10 | Total /100 | Disposition |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| OANDA v20 candles | 15 | 9 | 8 | 12 | 5 | 6 | 4 | 10 | 9 | **78** | Shortlist: account-owned current/historical |
| Twelve Data Basic | 15 | 7 | 8 | 11 | 8 | 8 | 7 | 10 | 9 | **83** | Shortlist: bounded self-service API |
| Dukascopy Historical Data Export | 15 | 7 | 10 | 4 | 8 | 9 | 9 | 8 | 8 | **78** | Shortlist: historical/backfill only |
| HistData manual export | 12 | 5 | 8 | 2 | 4 | 7 | 9 | 8 | 7 | **62** | Reject as primary; contingency fixture source |
| Alpha Vantage FX_INTRADAY | 8 | 6 | 5 | 8 | 5 | 2 | 7 | 10 | 7 | **58** | Reject for R1 target |

The numeric difference between shortlisted options is not decisive because
licensing, revisions, uptime and actual seven-pair entitlement still contain
unknowns.

## Option evidence

### A. OANDA v20 candles

**Sourced facts**

- The instrument candle endpoint supports bounded `from`/`to` queries and a
  maximum `count` of 5,000. It returns timestamps, a `complete` flag, volume and
  selectable midpoint/bid/ask candles. Alignment timezone defaults to
  `America/New_York`, while returned timestamps remain UTC.
  [Official endpoint](https://developer.oanda.com/rest-live-v20/instrument-ep)
- The granularity registry includes `M15`, `H1` and `H4`.
  [Official definitions](https://developer.oanda.com/rest-live-v20/instrument-df)
- A personal access token is tied to an OANDA account, grants access to all
  sub-accounts and must be treated like a password.
  [Official authentication](https://developer.oanda.com/rest-live-v20/authentication)

**Inference**

- All target pairs and intervals are likely directly representable.
- Plain REST makes SDK-independent normalization and fixture replay practical.
- Because the same token can reach account and order surfaces, R1.15 would need
  a strict hostname/method/path allowlist; application-level read-only behavior
  cannot be inferred from the token itself.

**Unknown**

- Exact regional account eligibility, cost and historical depth for this
  operator.
- Formal candle-revision policy, uptime/SLA and durable-use terms applicable to
  the operator's jurisdiction.
- Whether a market-data-only token scope exists; the reviewed authentication
  page does not state one.

### B. Twelve Data Basic

**Sourced facts**

- The time-series endpoint supports `15min`, `1h` and `4h`, output sizes from 1
  to 5,000, JSON/CSV output and an explicit timezone parameter.
  [Official time-series documentation](https://twelvedata.com/docs/llms/market-data/time-series.md)
- The individual Basic plan is free, advertises real-time forex, allows internal
  non-display use and lists 8 API credits per minute with 800 requests per day.
  The 99.95% SLA is shown for higher plans, not Basic.
  [Official pricing](https://twelvedata.com/pricing)

**Inference**

- Seven pairs × three intervals can fit bounded polling and backfill if calls
  are scheduled well below 8 credits/minute and 800/day.
- API-key authentication is narrower operationally than an account trading
  token, but R1.15 must still prevent secret leakage and all non-approved paths.
- Direct JSON/CSV access supports an SDK-independent adapter and captured
  fixtures.

**Unknown**

- Confirmed availability and historical depth for every target pair on the
  operator's actual Basic account.
- Candle source composition, bid/ask versus midpoint semantics, revision window,
  Basic-tier uptime and incident history.
- Whether the current personal/internal license permits every intended local
  derived artifact; terms must be accepted by the operator.

### C. Dukascopy Historical Data Export

**Sourced facts**

- Dukascopy describes free CSV historical export from tick-by-tick through
  monthly timeframes.
  [Official historical export](https://www.dukascopy.com/swiss/english/marketwatch/historical)
- Its website terms limit downloaded material to the user's personal,
  non-commercial use and prohibit resale/transfer absent written agreement.
  [Official terms](https://www.dukascopy.com/swiss/english/legal-pages/terms-of-use/)

**Inference**

- This is strong for reproducible historical backfill and offline fixtures.
- If a target interval is unavailable in a particular export path, deterministic
  aggregation from a smaller interval is feasible after candle-boundary tests.
- Manual/file export is SDK independent and can avoid a standing credential.

**Unknown**

- Stable machine API contract, rate limits, uptime, revision/change log and
  freshness suitable for ongoing current candles.
- Exact availability of every target pair and interval in the operator's chosen
  export interface.
- Whether automated repeated downloads are permitted by the applicable terms.

### D. HistData

**Sourced facts**

- HistData offers Generic ASCII M1 and tick downloads; its page describes paid
  FTP/SFTP and automatic-update options.
  [Download page](https://www.histdata.com/download-free-forex-historical-data)

**Inference**

- 15m/1h/4h require local aggregation from M1, increasing boundary and missing
  bar risk.
- Manual archives can seed fixtures but are not a sufficient ongoing freshness
  authority.

**Unknown / rejection**

- Provider-controlled licensing, revision policy, uptime, complete seven-pair
  coverage and automated free access were not established. Reject as primary.

### E. Alpha Vantage FX_INTRADAY

**Sourced facts**

- `FX_INTRADAY` is marked Premium, requires an API key and supports only
  `1min`, `5min`, `15min`, `30min` and `60min`; compact output returns 100
  points and full output returns the full intraday series.
  [Official documentation](https://www.alphavantage.co/documentation)

**Inference / rejection**

- 4h is not native and requires 60m aggregation.
- The required intraday FX endpoint is not a credible free-first fit. Reject for
  this R1 target even though JSON/CSV and SDK independence are acceptable.

**Unknown**

- Paid-plan history depth, revision behavior, seven-pair entitlement and uptime
  were not sufficiently established for reconsideration.

## Recommended shortlist—without selecting a winner

1. **Twelve Data Basic** for a narrowly allowlisted, bounded, self-service
   current/historical API evaluation.
2. **OANDA v20 candles** when the operator already owns an eligible account and
   accepts the broader-token risk that R1.15 must contain.
3. **Dukascopy Historical Data Export** for historical/backfill authority only,
   subject to personal-use terms and an explicit decision about automation.

Do not combine providers in R1.15. Approve one named provider or defer.

## Rejection reasons

- **Alpha Vantage:** target intraday FX is premium and 4h needs aggregation.
- **HistData:** manual M1/tick archives, unresolved licensing/automation and no
  adequate ongoing freshness authority.
- **Any undocumented scraper or unofficial SDK:** unstable contract, weak
  provenance and avoidable supply-chain/terms risk.

## Copy-ready authorization choice

Choose exactly one line, or choose defer:

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider Twelve Data sesuai prompt pack. Jangan panggil API sebelum credential
loader, endpoint allowlist, redaction, bounded retry/rate controls dan offline
fixture tests lulus.
```

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider OANDA v20 sesuai prompt pack. Jangan panggil API sebelum credential
loader, candle-only endpoint allowlist, redaction, bounded retry/rate controls
dan offline fixture tests lulus.
```

```text
Otorisasi implementasi HANYA R1.15 — Credential and Egress Boundary untuk
provider Dukascopy Historical Data Export sesuai prompt pack. Batasi ke
read-only historical export dan jangan otomatisasi akses sebelum terms,
allowlist, bounded download dan offline fixture tests lulus.
```

```text
Tunda pemilihan provider. Jangan mulai R1.15 dan pertahankan sistem offline.
```