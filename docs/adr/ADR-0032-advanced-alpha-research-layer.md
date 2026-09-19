# ADR-0032: Advanced-alpha research layer (meta-labeling, ML challengers, provider comparison, portfolio intelligence, adaptive research, feature sandbox)

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P18 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0005 (live OFF), ADR-0009 (canonical market data), ADR-0013 (dataset manifests), ADR-0018 (ensemble), ADR-0020 (research-lab gates), ADR-0022 (risk engine), ADR-0023 (analytics), ADR-0026 (registry)

## Context

The frozen blueprint phase P18 (Advanced Alpha) requires meta-labeling, an
ML challenger framework, multi-provider research comparison, portfolio
intelligence, online/adaptive research safety and an advanced feature
research sandbox — each with hard acceptance gates (OOS evaluation without
touching base history; ML production gated on complete evidence; no
provider treated as ground truth; portfolio decisions subordinate to risk
limits with explained rejections; online changes versioned and replayable;
experiments carrying source/licensing provenance).

## Decision

1. The advanced-alpha vocabulary lives in `contracts/src/advancedAlpha/` as
   pure, zod-validated TS modules (`metaLabeling`, `mlChallenger`,
   `providerCompare`, `portfolioIntel`, `adaptiveResearch`,
   `featureSandbox`, plus a local `util` with the FNV-1a 64-bit hash and
   6-decimal rounding conventions — duplicated deliberately, same rationale
   as `risk/util.ts`, so the research layer never depends on risk or
   observability modules). Barrel export `contracts/src/advancedAlpha/index.ts`.
2. P18-01 meta-labeling: binary labels are `netOutcomeR >= costThresholdR`
   (cost-aware); training samples require AT-SIGNAL-TIME feature context
   (a later context is post-signal leakage and fails closed); OOS evaluation
   requires P09 split/purge digest provenance and 1:1 sample/score pairing;
   `decideMetaLabel` emits `accept`/`abstain` with frozen reason codes and
   content-addressed ids (`mlab_`); base-strategy history is never mutated.
3. P18-02 ML challenger: feature-set schema binding (set-equality check at
   the scoring boundary), training manifest (dataset id+digest, split/purge
   digests, label rule, hyperparams, window), OOS evidence with
   walk-forward+purge digests, calibration (Brier + gap) and drift
   (mean-shift z) fields; deterministic champion/challenger comparison
   (strict primary-metric win, guardrails, ties never promote); the
   production gate `assessMlGate` refuses enablement unless ALL six checks
   pass — ML stays OFF by default (ADR-0005; blueprint champion gate). Model
   registration reuses the P13 registry (`RegistryEntry` kind `model`).
4. P18-03 provider comparison: pairwise spread (pips), candle (OHLC pips,
   pip size = instrument metadata) and timestamp-consistency comparisons;
   no provider is a reference (both ids recorded; deltas signed B - A);
   unmatched bars are explicit coverage gaps, never interpolated;
   findings (misaligned/duplicate/out-of-order) are visible sorted lists.
5. P18-04 portfolio intelligence: hard filters first (spread, min edge,
   position count, instrument capacity, strategy redundancy), then greedy
   selection by `expectedEdgeR - correlationPenaltyWeight * max|corr|` with
   heat-cap, daily-stop, duplicate-instrument-direction and
   correlation-threshold denials; every rejection carries a frozen reason
   code + detail; the selector never sizes positions and never relaxes a
   cap (P11 remains authoritative — subordination).
6. P18-05 adaptive research: experiments are versioned weight states with
   append-only events (weight updates/promotions/retirements), replayed by
   an idempotent fold that enforces version+1 bumps, strictly ascending
   UTC instants and terminal-state absorption; modes are `research|paper`
   ONLY (`live` is absent from the schema — online changes can never
   silently affect live behavior); promotion requires a P18-02 gate
   assessment id (`mlgate_...`).
7. P18-06 feature sandbox: experiments carry family (order-flow proxy,
   session microstructure, volatility term structure, macro/event,
   alternative data), a hypothesis of >= 20 chars, `feature@semver`
   lineage, a UTC research period, a P09 split digest, and a REQUIRED
   source/licensing note (verified claims require an evidence URL —
   ADR-0013 semantics); `alternative_data` experiments additionally
   require `licensed: true` (unlicensed alternative data cannot be
   sandboxed); `beatBaseline` is computed from the OOS numbers, never
   asserted; drafts (no result) and concluded experiments are
   schema-distinct.
8. All ids are content-addressed (`mlab_`, `mlcmp_`, `mlgate_`, `pcmp_`,
   `pcmpr_`, `pcts_`, `pidec_`, `adup_`, `adpro_`, `adret_`, `sbx_` +
   FNV-1a64) so identical inputs always yield identical ids (idempotent,
   replayable provenance). Deterministic; UTC-only; no wall clock, no
   randomness, no broker access anywhere in the layer.

## Consequences

- The advanced-alpha layer is contract-level only: no training code, no
  model hosting, no provider fetching — callers supply outcomes, scores,
  observations and evidence at the boundary (mirrors P15-P17 approach).
- Champion promotion of an ML model additionally requires the P13
  registry + P09 promotion lifecycle wiring (already present); this ADR
  adds the evidence gate, not a new registry.
- Portfolio selection outputs are ADVISORY downstream of risk: the P11
  engine re-checks every constraint independently (double barrier).
- Python mirrors under `quant/advancedAlpha` are deferred to a follow-up
  prompt; the TS contract is the source of truth for this phase.

## Verification

`contracts/src/__tests__/advanced-alpha.test.ts` (20 tests) pins every
section: label rule + boundary, leakage refusal, OOS 1:1 pairing +
determinism, accept/abstain reason codes + idempotent ids, feature-schema
binding + drift, champion/challenger verdicts (ties never promote), ML
gate fail-closed paths, spread/candle pip comparisons with visible
gaps, timestamp findings, portfolio greedy selection + explained
rejections + fail-closed config, weight-step bounds, live-mode refusal,
replay idempotency + version/jump/terminal enforcement, sandbox
provenance/verdict computation and unlicensed-alternative-data refusal.
Full contracts suite: 43 files / 631 tests green; `tsc --noEmit` clean.
