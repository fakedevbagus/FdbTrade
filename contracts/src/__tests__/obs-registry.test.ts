/**
 * Strategy/model registry contract tests (P13-03).
 *
 * Covers: happy path (strategy + model entries), malformed input (bad
 * artifactId/config hash/limitations), modelMetadata presence rule,
 * idempotent registration, different-content-same-artifact refused,
 * deterministic ids (run order + hyperparam order independent), canonical
 * serialization pinned, champion/challenger linkage from P09 promotion
 * records, and run traceability queries.
 */
import { describe, expect, it } from "vitest";

import { openCandidate, applyPromotionTransition, attachEvidence } from "../research/promotion";

import {
  createRegistry,
  REGISTRY_ARTIFACT_KINDS,
  registryChampions,
  registryEntriesForRun,
  registryEntryIdFor,
  registryStateFor,
  registerRegistryEntry,
  RegistryError,
  serializeRegistryEntryCanonical,
  type RegistryEntryInput,
} from "../obs/registry";

const T0 = "2026-09-11T12:00:00.000Z";
const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function strategyInput(overrides: Partial<RegistryEntryInput> = {}): RegistryEntryInput {
  return {
    kind: "strategy",
    artifactId: "trend-pullback@1.2.0",
    configHash: SHA64,
    dataset: { datasetId: "ds-eurusd-1h-2026", digest: SHA64 },
    modelMetadata: null,
    state: "candidate",
    researchRunIds: ["run-alpha-1", "run-beta-2"],
    limitations: "Trend-following only; no range-regime edge; single instrument family.",
    registeredAtUtc: T0,
    registeredBy: "owner",
    ...overrides,
  };
}

function modelInput(overrides: Partial<RegistryEntryInput> = {}): RegistryEntryInput {
  return {
    kind: "model",
    artifactId: "ml-classifier@0.1.0",
    configHash: SHA64,
    dataset: { datasetId: "ds-features-2026", digest: SHA64 },
    modelMetadata: {
      family: "gradient_boosting",
      featureSet: ["rsi.14@1.0.0", "atr.14@1.0.0"],
      trainDatasetId: "ds-features-2026",
      trainDatasetDigest: SHA64,
      hyperparams: { depth: 3, learningRate: 0.05 },
    },
    state: "candidate",
    researchRunIds: ["run-model-1"],
    limitations: "Experimental; ML production disabled until champion gate passes.",
    registeredAtUtc: T0,
    registeredBy: "owner",
    ...overrides,
  };
}

describe("registry entry schema", () => {
  it("happy path: strategy entry registers with a content-addressed id", () => {
    const { registry, entry } = registerRegistryEntry(createRegistry(), strategyInput());
    expect(entry.entryId).toMatch(/^reg_[0-9a-f]{16}$/);
    expect(entry.entryId).toBe(registryEntryIdFor(strategyInput()));
    expect(registry.entries).toHaveLength(1);
    expect(entry.modelMetadata).toBeNull();
  });

  it("happy path: model entry carries required model metadata", () => {
    const { entry } = registerRegistryEntry(createRegistry(), modelInput());
    expect(entry.modelMetadata?.family).toBe("gradient_boosting");
    expect(entry.modelMetadata?.featureSet).toContain("rsi.14@1.0.0");
  });

  it("modelMetadata presence is kind-pinned (refused when wrong)", () => {
    expect(() =>
      registerRegistryEntry(
        createRegistry(),
        strategyInput({ modelMetadata: modelInput().modelMetadata }),
      ),
    ).toThrow(/modelMetadata/);
    expect(() =>
      registerRegistryEntry(createRegistry(), modelInput({ modelMetadata: null })),
    ).toThrow(/modelMetadata/);
  });

  it("rejects malformed artifact ids, config hashes and short limitations", () => {
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ artifactId: "Trend Pullback@1.0.0" })),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ artifactId: "no-version" })),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ configHash: "abc" })),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ limitations: "too short" })),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(
        createRegistry(),
        strategyInput({ dataset: { datasetId: "d", digest: "zz" } }),
      ),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ registeredBy: "Bad Actor" })),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(createRegistry(), strategyInput({ state: "championed" as never })),
    ).toThrow();
  });

  it("rejects malformed model metadata", () => {
    expect(() =>
      registerRegistryEntry(
        createRegistry(),
        modelInput({
          modelMetadata: {
            family: "",
            featureSet: ["rsi.14@1.0.0"],
            trainDatasetId: "d",
            trainDatasetDigest: SHA64,
            hyperparams: {},
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      registerRegistryEntry(
        createRegistry(),
        modelInput({
          modelMetadata: {
            family: "x",
            featureSet: ["bad-feature-name"],
            trainDatasetId: "d",
            trainDatasetDigest: SHA64,
            hyperparams: {},
          },
        }),
      ),
    ).toThrow();
  });
});

describe("registration semantics", () => {
  it("idempotent: same content registers once and returns the same entry", () => {
    let registry = createRegistry();
    const first = registerRegistryEntry(registry, strategyInput());
    registry = first.registry;
    const second = registerRegistryEntry(registry, strategyInput());
    expect(second.registry.entries).toHaveLength(1);
    expect(second.entry.entryId).toBe(first.entry.entryId);
  });

  it("refuses the same artifactId with different content", () => {
    const registry = registerRegistryEntry(createRegistry(), strategyInput()).registry;
    expect(() =>
      registerRegistryEntry(
        registry,
        strategyInput({ limitations: "Different limitations text for the same version." }),
      ),
    ).toThrow(RegistryError);
    expect(registry.entries).toHaveLength(1);
  });

  it("a NEW version of the same strategy registers separately", () => {
    let registry = registerRegistryEntry(createRegistry(), strategyInput()).registry;
    registry = registerRegistryEntry(
      registry,
      strategyInput({ artifactId: "trend-pullback@1.3.0" }),
    ).registry;
    expect(registry.entries).toHaveLength(2);
  });
});

describe("determinism + serialization", () => {
  it("run order and hyperparam order do not change the id", () => {
    const a = strategyInput({ researchRunIds: ["run-a", "run-b"] });
    const b = strategyInput({ researchRunIds: ["run-b", "run-a"] });
    expect(registryEntryIdFor(a)).toBe(registryEntryIdFor(b));
    const m1 = modelInput();
    const m2 = modelInput({
      modelMetadata: {
        ...m1.modelMetadata!,
        hyperparams: { learningRate: 0.05, depth: 3 },
      },
    });
    expect(registryEntryIdFor(m1)).toBe(registryEntryIdFor(m2));
  });

  it("canonical serialization is pinned", () => {
    const { entry } = registerRegistryEntry(createRegistry(), strategyInput());
    expect(serializeRegistryEntryCanonical(entry)).toBe(
      [
        "reg",
        "strategy",
        "trend-pullback@1.2.0",
        SHA64,
        "ds-eurusd-1h-2026",
        SHA64,
        "-",
        "candidate",
        "run-alpha-1,run-beta-2",
        "Trend-following only; no range-regime edge; single instrument family.",
        T0,
        "owner",
        entry.entryId,
      ].join("|"),
    );
  });
});

describe("champion/challenger linkage (no promote without evidence)", () => {
  it("state derives from the P09 promotion record, never invented", () => {
    let promotion = openCandidate({
      strategyId: "trend-pullback",
      strategyVersion: "1.2.0",
      configVersion: "1.0.0",
    });
    expect(registryStateFor(promotion)).toBe("candidate");
    promotion = attachEvidence(promotion, {
      splitPlanHash: SHA64,
      walkforwardPlanHash: SHA64,
      purgeReportHash: SHA64,
      stressSummaryHash: SHA64,
      oosNetReturn: 120.5,
      oosMaxDrawdown: 40.2,
      walkforwardMedianNetReturn: 80.1,
    });
    promotion = applyPromotionTransition(promotion, {
      strategyId: "trend-pullback",
      from: "candidate",
      to: "challenger",
      atUtc: T0,
      reason: "walk-forward evidence attached",
    });
    expect(registryStateFor(promotion)).toBe("challenger");
    let registry = createRegistry();
    registry = registerRegistryEntry(
      registry,
      strategyInput({ state: registryStateFor(promotion) }),
    ).registry;
    expect(registryChampions(registry)).toEqual([]);
    const championPromotion = applyPromotionTransition(promotion, {
      strategyId: "trend-pullback",
      from: "challenger",
      to: "champion",
      atUtc: "2026-09-11T12:00:01.000Z",
      reason: "beat incumbent",
    });
    expect(registryStateFor(championPromotion)).toBe("champion");
    registry = registerRegistryEntry(
      registry,
      strategyInput({ artifactId: "trend-pullback@1.4.0", state: "champion" }),
    ).registry;
    expect(registryChampions(registry).map((e) => e.artifactId)).toEqual([
      "trend-pullback@1.4.0",
    ]);
  });

  it("a malformed promotion record is refused at the boundary", () => {
    expect(() => registryStateFor({ state: "champion" } as never)).toThrow();
  });
});

describe("research-run traceability", () => {
  it("entries are queryable by linked research run id", () => {
    let registry = createRegistry();
    registry = registerRegistryEntry(registry, strategyInput()).registry;
    registry = registerRegistryEntry(
      registry,
      modelInput({ researchRunIds: ["run-alpha-1"] }),
    ).registry;
    expect(registryEntriesForRun(registry, "run-alpha-1")).toHaveLength(2);
    expect(registryEntriesForRun(registry, "run-none")).toEqual([]);
  });

  it("frozen vocabularies stay stable", () => {
    expect(REGISTRY_ARTIFACT_KINDS).toEqual(["strategy", "model"]);
  });
});

