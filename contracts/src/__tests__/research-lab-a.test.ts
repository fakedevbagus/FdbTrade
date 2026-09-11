/**
 * Research-lab contract tests part 1 (P09, ADR-0020): splits + walkforward.
 */
import { describe, expect, it } from "vitest";

import {
  barsOfSection,
  planResearchSplit,
  serializeResearchSplitCanonical,
} from "../research/splits";
import {
  planWalkforward,
  serializeWalkforwardCanonical,
} from "../research/walkforward";

describe("research splits (P09-01)", () => {
  it("partitions 100 bars 60/20/20 with a 2-bar gap (hand-checked)", () => {
    const plan = planResearchSplit({
      barCount: 100,
      trainRatio: 0.6,
      validateRatio: 0.2,
      testRatio: 0.2,
      gapBars: 2,
      minSectionBars: 1,
      seed: "p09-01",
    });
    expect(plan.train).toEqual({ section: "train", startBar: 0, endBar: 60 });
    expect(plan.validate).toEqual({ section: "validate", startBar: 62, endBar: 82 });
    expect(plan.test).toEqual({ section: "test", startBar: 84, endBar: 100 });
    expect(plan.purgedBars).toEqual([60, 61, 82, 83]);
    expect(barsOfSection(plan, "train")).toHaveLength(60);
    expect(serializeResearchSplitCanonical(plan)).toBe(
      "rsplit|research-splits|1.0.0|100|2|p09-01|train:0-60|validate:62-82|test:84-100",
    );
  });

  it("is deterministic and fails closed on malformed ratios", () => {
    const input = {
      barCount: 50,
      trainRatio: 0.5,
      validateRatio: 0.3,
      testRatio: 0.2,
      gapBars: 1,
      minSectionBars: 1,
      seed: "p09-01",
    } as const;
    const a = planResearchSplit({ ...input });
    const b = planResearchSplit({ ...input });
    expect(a).toEqual(b);
    expect(() =>
      planResearchSplit({ barCount: 100, trainRatio: 0.5, validateRatio: 0.5, testRatio: 0.5, gapBars: 0, minSectionBars: 1, seed: "x" }),
    ).toThrow();
    expect(() =>
      planResearchSplit({
        barCount: 10, trainRatio: 0.6, validateRatio: 0.2, testRatio: 0.2, gapBars: 4, minSectionBars: 1, seed: "x",
      }),
    ).toThrow();
  });
});

describe("walk-forward (P09-02)", () => {
  it("rolls 4 folds over 30 bars (train 10 / test 5 / step 5)", () => {
    const plan = planWalkforward({
      barCount: 30, trainBars: 10, testBars: 5, stepBars: 5, mode: "rolling", gapBars: 0, minFolds: 1, seed: "p09-02",
    });
    expect(plan.folds).toHaveLength(4);
    expect(plan.folds[0].train).toMatchObject({ startBar: 0, endBar: 10 });
    expect(plan.folds[0].test).toMatchObject({ startBar: 10, endBar: 15 });
    expect(plan.folds[2].test).toMatchObject({ startBar: 20, endBar: 25 });
    expect(plan.folds[3].test).toMatchObject({ startBar: 25, endBar: 30 });
    const tests = plan.folds.flatMap((f) =>
      Array.from({ length: f.test.endBar - f.test.startBar }, (_, i) => f.test.startBar + i),
    );
    expect(new Set(tests).size).toBe(tests.length);
    expect(serializeWalkforwardCanonical(plan)).toContain(
      "wforward|research-walkforward|1.0.0|30|rolling|5|0|p09-02",
    );
  });

  it("expands the train anchor from bar 0", () => {
    const plan = planWalkforward({
      barCount: 30, trainBars: 10, testBars: 5, stepBars: 5, mode: "expanding", gapBars: 0, minFolds: 1, seed: "p09-02",
    });
    expect(plan.folds[1].train).toMatchObject({ startBar: 0, endBar: 15 });
  });
});
