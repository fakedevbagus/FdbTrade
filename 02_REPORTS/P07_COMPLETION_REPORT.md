# Completion Report

Prompt ID: P07_Signal_UX (P07-01 through P07-05, executed in required order)
Phase: P7 Signal UX
Date/time UTC: 2026-09-10T13:45Z
Branch/commit: main / five focused commits, HEAD 25b3de0 (P07-05)

## What changed

The P7 Signal UX phase is complete: the private command center (P07-01),
the instrument/timeframe scanner (P07-02), the signal detail view
(P07-03), the chart + signal overlays (P07-04) and the alert center
(P07-05). The phase gate "Command Center + scanner + detail + alert
center" is satisfied and `make check` is green (lint + typecheck + full
test suite + build for every package).

### P07-01 — Private command center
- `backend/src/signals/pipeline.ts`: deterministic READ-ONLY pipeline
  over the fixture provider for an explicit `asOfUtc` closed 1h bar —
  fixture candles -> regime (P04 classifier + HTF context) -> all four
  P5 baseline strategies -> ensemble votes -> P06-02 weighting -> P06-03
  cost/edge gate -> P06-04 calibration stamp -> P06-05 ranking ->
  dashboard snapshot. Fail closed per instrument (session gap / weekend /
  insufficient history become explicit stale/error rows, never fabricated
  data). No wall clock, no randomness: identical request -> byte-identical
  snapshot (pinned by tests). Includes the P07-03 detail builder and the
  P07-04 chart builder (appended in their prompts).
- `backend/src/signals/weights.ts` + `backend/src/strategy/all.ts`:
  baseline strategy registry (single id/version source) + versioned
  dashboard weight table (documented PLACEHOLDER, unknown regime empty =
  fail closed — never tuned before P8/P9).
- `GET /api/dashboard` (session-guarded, strict `asOfUtc` query, 400 on
  malformed/misaligned input, 405 on writes).
- Frontend `/dashboard`: market overview (fixture-labeled quotes,
  1h change, regime, FreshnessBadge), active signals (live-only,
  direction-consistent levels), regime summary, data freshness (counts
  + per-instrument errors), portfolio heat (explicit placeholder — no
  fake risk numbers), top opportunities (rank/edge/confidence + the
  "scores are NOT win probabilities" note). Loading via route
  `loading.tsx`, error via `error.tsx` + inline ErrorState, empty via
  EmptyState, stale visibly marked.

### P07-02 — Scanner
- `backend/src/signals/scanner.ts`: pure filter/sort engine — direction
  (any/long/short/wait-only), regime (exact match), minConfidence,
  minEdgePips, freshOnly, maxAgeBars (inclusive boundaries), sort by
  rank/score/edge/confidence/age; deterministic decisionId-ascending
  tie-break; input-order independent; canonical URL-state round-trip
  (`scannerQueryToParams`/`FromParams`, sorted keys, strict number
  formats; unknown/duplicate params reject fail-closed).
- `GET /api/signals/scanner`: validated query, canonical params echoed in
  the response (URL state reproducible from the reply itself).
- Frontend `/scanner`: link-based filters (URL IS the state — every view
  reproducible by copying the URL), stale rows dimmed, empty state
  explains exactly how many candidates were excluded. NO order button,
  no trading action anywhere (prompt non-goal).

### P07-03 — Signal detail
- `buildSignalDetail`: full stored-decision view — action/direction,
  verbatim votes with lineage (strategy/logic/config versions), weights
  version, decisionHash, confidence components (vote/weighted agreement,
  regime alignment, correlation penalty, calibration view with
  empiricalHitRate/sampleSize/uncertaintyFlags), regime context entries,
  edge report recomputed deterministically and LABELED derived, data
  quality (fresh/barsBehind/degraded, labeled derived), honest strategy
  performance context (`hasBacktestStats: false` until P8/P12), live
  expiry. Unknown decisionId -> 404, never improvised.
- `GET /api/signals/[id]` (strict decisionId shape, session-guarded).
- Frontend `/signals/[id]`: BUY/SELL/WAIT headline, entry zone, SL/TP,
  R:R + expected move + cost floor + net edge (each labeled derived),
  confidence vs empirical hit-rate (separate tables + the "confidence is
  NOT a win probability" disclaimer), reasons, regime table, data
  quality, verbatim strategy votes, honest performance context.

### P07-04 — Chart and signal overlays
- `buildSignalChart`: fixture bars ending at the decision bar (UTC open
  times, OHLC), signal marker pinned to the decision bar's open time,
  entry/SL/TP overlays from the stored dominant-signal levels, stale
  flag + barsBehind, dominant-vote feature rows for the context panel.
- `GET /api/signals/[id]/chart`.
- `CandleChart.tsx`: dependency-free SVG chart primitives — pure
  geometry from market coordinates (x = bar open-time index, y = price on
  a linear axis spanning bars + overlay levels), overlay lines at stored
  prices, marker polygons at the decision bar, stale caption. Embedded
  in the detail page with the feature/context panel. No external chart
  library, no third-party chart embed/scrape (guard test enforces).

### P07-05 — Alert center
- `backend/src/signals/alerts.ts`: in-app alert preferences (zod-strict:
  enabled master switch, per-event-class toggles, channel) + the
  `AlertDelivery` provider abstraction with the NO-OP provider first
  (email/Telegram adapters slot in later behind the same interface) +
  `AlertCenter` with idempotent dispatch (eventId = sha256 of
  decisionId|class; re-dispatch returns the existing event, no duplicate
  record, no duplicate delivery; first-write recordedAtUtc wins).
  Failures/skips are RECORDED with structured reasons and never thrown —
  alert delivery can never block signal creation (acceptance criterion).
  No wall clock in dispatch logic; no WhatsApp automation.
- `GET/PUT /api/alerts/preferences` (PUT validated via parseJsonBody),
  `GET /api/alerts/events` (read-only log with statuses + reasons).
- Frontend `/alerts`: preferences form (master + class toggles, honest
  no-op channel note, save errors surfaced) + event log table (status
  badges, attempts, failure detail) + empty state.

## Files changed

Backend (new): `src/signals/{pipeline,weights,scanner,alerts}.ts`,
`src/signals/__tests__/{pipeline,scanner,detail,chart,alerts}.test.ts`,
`src/strategy/all.ts`, `src/app/api/dashboard/route.ts` (+tests),
`src/app/api/signals/{scanner,[id],[id]/chart}/route.ts` (+tests),
`src/app/api/alerts/{preferences,events}/route.ts` (+tests).
Frontend (new): `src/lib/{dashboard,scanner,signal-detail,signal-chart,
alerts}.ts`, `src/lib/__tests__/{dashboard,scanner,alerts}.test.ts(x)`,
`src/components/dashboard/DashboardContent.tsx` (+tests),
`src/components/chart/CandleChart.tsx` (+tests),
`src/components/alerts/AlertPreferencesForm.tsx`,
`src/components/ui/FreshnessBadge.tsx`, `src/app/(app)/{scanner,
signals/[id],alerts}/page.tsx`.
Frontend (modified): `src/app/(app)/dashboard/page.tsx` (placeholder ->
real command center), `src/app/globals.css` (table/badge/chart tokens),
`src/middleware.ts` + `src/lib/site-config.ts` (protected routes + nav),
`src/components/ui/index.ts`.
Tests: `tests/test_signal_ux_contracts.py` (new, 28 checks across all
five prompts).
Docs: `02_REPORTS/P07_COMPLETION_REPORT.md`, root `COMPLETION_REPORT.md`.

## Tests executed

- `make check` (root): pnpm -r lint + typecheck + vitest for backend &
  frontend & contracts, python3 unittest discovery (409+ Python tests,
  28 of them P07 contract checks), all package builds — PASS (exit 0,
  "All workspace checks passed") at every prompt gate.
- Backend vitest totals for P7: pipeline 13, scanner 22, detail 6,
  chart 8, alerts 14, dashboard route 8, scanner route 8, detail route 6
  (plus pre-existing suites all green).
- Frontend vitest totals for P7: dashboard lib 9, DashboardContent 10,
  scanner lib 8, chart 9, alerts 11 (75 frontend tests total).
- Python: `tests/test_signal_ux_contracts.py` 28/28; the repo-wide
  safety scanners (no execution tokens in API/UI sources, no
  TradingView references, secrets scan) pass.

## Acceptance criteria

- [x] P07-01: responsive command center renders real backend/fixture
      data with loading/error/stale states (route loading.tsx +
      ErrorState + EmptyState + FreshnessBadge; fixture source labeled;
      weekend/session-gap rows stale by test).
- [x] P07-02: filtering/sorting deterministic and URL state
      reproducible (decisionId tie-break, input-order independence,
      toParams/fromParams round-trip byte-identity; canonical params
      echoed by the API and rendered on the page). No order button.
- [x] P07-03: every displayed claim maps to stored signal fields or
      clearly labeled derived analytics (edge/dataQuality carry
      `derived: true`; performance context honest until P8/P12;
      confidence vs empirical hit-rate separated with the
      no-win-probability disclaimer).
- [x] P07-04: overlay coordinates match market timestamps/prices
      (x = bar open-time index, y = stored price levels; marker pinned
      to the decision bar open time — proven by tests); stale data
      visibly marked (badge + chart caption). No TradingView embed or
      scrape (static guard test).
- [x] P07-05: alert events idempotent (sha256 eventId; duplicate
      dispatch returns the same event, delivery called once); failures
      surfaced without blocking signal creation (provider throws
      recorded, dispatch never throws; skips recorded too). No
      WhatsApp automation.
- [x] Relevant tests pass from a clean environment — `make check`
      green at every prompt gate.
- [x] Lint/typecheck/build clean for all affected packages.
- [x] No unrelated files modified (dashboard placeholder page was the
      explicit P07-01 target; middleware/nav/CSS changes are the
      minimal wiring for the new protected routes).
- [x] Completion report written (this file, mirrored at root).

## Known limitations / blockers

- The dashboard weight table, edge-gate cost inputs (slippage 0.3,
  multiple 2) and the empty correlation penalty are documented
  placeholders — NOT tuned, pending the P8 harness / P9 validation
  gates (ADR-0016/0017/0018 discipline).
- The pipeline is fixture-backed and 1h-only by design (read-only
  intelligence); live providers, multi-timeframe scans and a durable
  decision/alert store are later-phase work (P8+ determines storage).
- In-memory alert store: preferences/events reset on process restart
  until a durable store lands; the contract (schemas + idempotent ids)
  is the stable surface.
- Calibration is always `no_calibration_data` on fresh evaluations
  (outcome tracking arrives with P12); the UI shows this honestly.
- Chart is deliberately minimal SVG (no zoom/pan/time-axis labels yet)
  — coordinates are correct and tested; richness can grow later.
- The detail/chart routes derive the id from the URL path (Next dynamic
  route params are not threaded through `withApi`); ids are
  regex-validated fail-closed before use.

## Follow-up required before next prompt

None blocking. The P7 phase gate ("Command Center + scanner + detail +
alert center") is satisfied.

## Risk notes

Quant: every displayed number maps to a stored decision/signal field or
a field explicitly labeled derived (edge/quality) — no fabricated
performance anywhere; portfolio heat is an explicit placeholder. The
pipeline is a pure function of `asOfUtc` (no wall clock), byte-identical
for identical requests, and reuses the P6 layers unchanged (weighting,
edge gate, calibration, ranking). No look-ahead: evaluations end at the
closed bar; active signals require expiry > asOf. Confidence is model
certainty in [0,1] — never a win probability; empirical hit-rate is a
separate measured field with uncertainty flags; the scanner/detail pages
carry the disclaimer. UTC everywhere (ADR-0004).
Security: no secrets in source, fixtures, logs or browser bundles; all
routes session-guarded (`requireSession`) and schema-validated at the
boundary (zod strict, fail closed); structured 4xx errors never leak
internals; the safety scanners (execution tokens, TradingView, secrets)
run in CI.
Trading safety: no UI, pipeline or alert code calls any execution path;
there is no order button anywhere; alert delivery can never block signal
creation; live execution remains OFF (ADR-0005); risk hard limits stay
authoritative and independent (blueprint).

## Next prompt (safe to run)

`01_PROMPTS/P08_Backtest_Engine/` — event-driven backtest with realistic
costs and golden run, per `00_CONTROL/RUN_ORDER.md` (P7 gate passed).
