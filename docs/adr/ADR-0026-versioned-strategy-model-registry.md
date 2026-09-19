# ADR-0026: Versioned strategy/model registry with research-run linkage

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (approved via P13 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0005 (live OFF), ADR-0013 (dataset manifests), ADR-0019 (backtest runs), ADR-0020 (research-lab promotion gates), ADR-0025 (audit log)

## Context

The frozen blueprint's P13 phase requires an admin registry for strategy
versions, datasets, config hashes, model metadata, champion/challenger state
and limitations, with the acceptance criterion that registry entries are
versioned and linked to research runs, and the non-goal that no promote
action exists without gate evidence. P09 already defines the
candidate/challenger/champion lifecycle with evidence requirements
(ADR-0020); the registry must expose and attribute artifacts without
weakening that gate or inventing lifecycle state.

## Decision

1. The registry vocabulary lives in `contracts/src/obs/registry.ts` as pure,
   typed, zod-validated TS. `RegistryEntry` carries kind
   (`strategy|model`), `artifactId` (`name@semver`), `configHash` (sha256 of
   the canonical config serialization — P08 semantics), dataset reference
   (id + digest — P02-05 manifest semantics), model metadata (REQUIRED for
   `model` artifacts, FORBIDDEN for `strategy` artifacts — schema-pinned),
   lifecycle `state`, `researchRunIds`, REQUIRED `limitations` text (20-1000
   chars — an artifact must state what it does not do), `registeredAtUtc`
   and `registeredBy`.
2. Entries are immutable and content-addressed (`reg_` + FNV-1a64 of the
   canonical serialization; sorted run ids and hyperparameters, fixed field
   order). Registration is idempotent per content; the same `artifactId` with
   DIFFERENT content is refused (`RegistryError`); a new semver of the same
   artifact registers as a separate entry.
3. Model metadata carries training lineage: family, feature set
   (`feature@semver` — P03 lineage), train dataset id + digest, and scalar
   hyperparameters. ML production status stays disabled until the champion
   gate passes (blueprint); registering a model makes it VISIBLE, not live.
4. Champion/challenger state is NEVER invented by the registry:
   `registryStateFor` derives it from a validated P09 `PromotionRecord`
   (whose `applyPromotionTransition` enforces the evidence gate — promotion
   to challenger/champion requires attached walk-forward/purge/stress
   evidence). The admin API and UI expose NO promote action.
5. Every successful NEW registration appends a `strategy_version` audit
   event (ADR-0025) with artifact identity and dataset/config provenance;
   idempotent re-registrations append nothing.
6. Surfaces: backend `GET /api/admin/registry` (read-only, session-guarded,
   entries + champions list; write methods 405) and the frontend
   `/admin/registry` page (server-rendered, zod-validated client, fail
   closed; states badged; limitations and research runs displayed; explicit
   read-only notice). `registeredAtUtc` is caller input — wall clock is read
   only at the backend registration boundary as the default.

## Consequences

- Every registered artifact is attributable to its exact config hash,
  dataset digest, limitations, research runs and (for models) training
  lineage — the registry is the admin-facing index over P08/P09 evidence.
- The registry does not store run artifacts themselves (P08 run store owns
  that); it stores the linkage, which keeps the entry small and immutable.
- In-memory process-lifetime storage; a durable store can be added later
  behind the same contract without schema churn.
- The registry deliberately has no promote/rollback action — that authority
  stays in the P09 promotion registry with its evidence gate (P13-05
  operational controls will route through the same gate, not around it).

## Verification

- `pnpm --filter @fdbtrade/contracts run test` — `obs-registry.test.ts` (14
  tests) green: strategy/model happy paths, kind-pinned modelMetadata,
  malformed ids/hashes/limitations refused, idempotent registration,
  same-artifact different-content refused, new-semver registration,
  deterministic ids (run/hyperparam order), pinned canonical serialization,
  champion/challenger state derived from real promotion records
  (openCandidate -> attachEvidence -> transitions), malformed promotion
  refusal, run traceability.
- `pnpm --filter @fdbtrade/backend run test` — registry suite green:
  register + audit append, idempotent no-duplicate-audit, content-collision
  refusal, malformed refusal, API 200/401/405.
- `pnpm --filter @fdbtrade/frontend run test` — registry client tests green
  (valid/malformed parse, non-200/unreachable fail closed).
- contracts + backend + frontend typecheck: 0 errors; lint clean.
