# Completion Report

Prompt ID: P13-03 Build strategy/model registry UI
Phase: P13 Admin & Observability
Date/time UTC: 2026-09-11T23:32:00Z
Branch/commit: main / c001db9 + P10–P13-03 working tree (uncommitted)

## What changed

Versioned strategy/model registry with research-run linkage and a read-only
admin UI (ADR-0026). Registry entries are immutable, content-addressed and
attributable to dataset digests, config hashes, limitations and research
runs; champion/challenger state derives from the P09 promotion registry
(evidence gate intact) and is never invented. No promote action exists
anywhere in the new surfaces.

- `contracts/src/obs/registry.ts` (new): `RegistryEntry` (kind
  `strategy|model`; `artifactId` `name@semver`; sha256 config hash; dataset
  id+digest; model metadata REQUIRED for models / FORBIDDEN for strategies,
  schema-pinned; P09 promotion state; research run ids; REQUIRED limitations
  text; registeredAtUtc/By). Content-addressed `reg_` ids (run + hyperparam
  order independent); idempotent registration; same-artifactId different
  content refused; new semver registers separately. `registryStateFor`
  derives state from a VALIDATED P09 `PromotionRecord`;
  `registryChampions` / `registryEntriesForRun` queries.
- `backend/src/obs/registryService.ts` (new): process-wide registry; every
  NEW registration appends a `strategy_version` audit event (ADR-0025) with
  artifact + dataset provenance; idempotent re-registration appends nothing;
  wall clock only at the registration boundary.
- `backend/src/app/api/admin/registry/route.ts` (new): read-only
  session-guarded `GET` (entries + champions + count; writes 405). No
  registration/promotion endpoint — the API cannot be used to promote.
- `frontend/src/lib/registry.ts` (new): zod-validated API client, fail
  closed (non-200/unreachable/malformed -> `{ ok: false }`).
- `frontend/src/app/(app)/admin/registry/page.tsx` (new): server-rendered
  admin page — artifact, kind, state badges, dataset + config-hash digests,
  research runs, registered UTC, limitations; champion list; explicit
  read-only notice (promotion requires P09 evidence; ML production disabled
  until champion gate).
- ADR-0026 recorded + indexed; CI ADR registry synchronized.

## Files changed

- contracts/src/obs/registry.ts (new)
- contracts/src/__tests__/obs-registry.test.ts (new)
- contracts/src/index.ts (barrel export)
- backend/src/obs/registryService.ts (new)
- backend/src/obs/__tests__/registryService.test.ts (new)
- backend/src/app/api/admin/registry/route.ts (new)
- frontend/src/lib/registry.ts (new)
- frontend/src/lib/__tests__/registry.test.ts (new)
- frontend/src/app/(app)/admin/registry/page.tsx (new)
- docs/adr/ADR-0026-versioned-strategy-model-registry.md (new)
- docs/adr/README.md (index row)
- tests/test_ci_contracts.py (KNOWN_ADRS entry — required registry sync)

## Tests executed

- `pnpm --filter @fdbtrade/contracts run test`: 27 files / 388 tests green
  (14 new registry tests incl. champion derivation through real P09
  openCandidate -> attachEvidence -> transition chain).
- `pnpm --filter @fdbtrade/backend run test`: obs suites 30/30 green
  (7 new registryService/route tests incl. audit-appended registration,
  idempotent no-duplicate-audit, content-collision refusal, 401/405).
- `pnpm --filter @fdbtrade/frontend run test`: 10 files / 81 tests green
  (6 new registry client tests).
- contracts + backend + frontend typecheck: 0 errors; lint clean.
- `python3 -m unittest tests.test_ci_contracts`: 18/18 green.

## Acceptance criteria

- [x] Registry entries are versioned (semver artifactId; immutable per
  version) and linked to research runs (`researchRunIds` + run
  traceability query + backend audit event with dataset/config provenance).
- [x] No promote action without gate evidence (no promote endpoint/UI
  action; state derives from validated P09 promotion records with their
  evidence requirement).
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified (ADR index + CI ADR registry are the
  required synchronization for ADR-0026).
- [x] Completion report written.

## Known limitations / blockers

- Registry storage is in-memory process-lifetime; durable storage can be
  added later behind the same contract.
- The registry starts empty (no runtime call site registers artifacts yet);
  registration is wired through `RegistryService.register` for research-lab
  adoption in later prompts. The empty state renders an explicit EmptyState —
  never fabricated rows.
- Port-3000 pre-existing blocker for `make start`-based Python acceptance
  still applies.

## Follow-up required before next prompt

- None. Next prompt per required order: P13-04 Build provider/system health
  dashboard.

## Risk notes

- Trading safety: registry is read-only everywhere; no broker access; no
  promotion authority; live execution remains OFF (ADR-0005); ML production
  stays disabled until the champion gate (blueprint) — registering a model
  makes it visible, not live.
- Quant integrity: entries pin config hash + dataset digest + limitations +
  research-run linkage (full provenance per blueprint); champion state
  cannot bypass the P09 evidence gate; deterministic content-addressed ids.
- Security: session-guarded surfaces (401) + write-method guards (405);
  model hyperparams are scalars through the redaction boundary; no secrets
  in fixtures, payloads or the UI.
