/**
 * Stress testing + Monte Carlo (P09-04, ADR-0020 section 4).
 *
 * Deterministic scenario grid over explicit cost/latency assumptions
 * (spread/slippage/commission multipliers, extra latency bars) plus a
 * seeded block-reshuffle Monte Carlo over the per-trade PnL sequence.
 * Historical results stay labeled `historical`; every stressed output is
 * labeled `stressed:<scenarioId>` so the two can never be confused.
 * No randomness without an explicit seed; the seed stream is a
 * counter-hashed LCG (deterministic across TS and Python).
 */
import { z } from "zod";

export const RESEARCH_STRESS_ID = "research-stress";
export const RESEARCH_STRESS_VERSION = "1.0.0";

export const RESULT_KINDS = ["historical", "stressed"] as const;
export type StressResultKind = (typeof RESULT_KINDS)[number];

/** One deterministic stress scenario (multipliers >= 0, latency >= 0). */
export const stressScenarioSchema = z
  .object({
    scenarioId: z.string().min(1).max(64),
    spreadMultiplier: z.number().finite().min(0),
    slippageMultiplier: z.number().finite().min(0),
    commissionMultiplier: z.number().finite().min(0),
    extraLatencyBars: z.number().int().min(0),
  })
  .strict();

export type StressScenario = z.infer<typeof stressScenarioSchema>;

export const stressRequestSchema = z
  .object({
    baseSpreadPips: z.number().finite().min(0),
    baseSlippagePips: z.number().finite().min(0),
    baseCommissionPips: z.number().finite().min(0),
    baseLatencyBars: z.number().int().min(1),
    scenarios: z.array(stressScenarioSchema).min(1).max(64),
    monteCarloSamples: z.number().int().min(1).max(10000),
    monteCarloBlocks: z.number().int().min(1),
    seed: z.string().min(1),
  })
  .strict()
  .refine(
    (r) => new Set(r.scenarios.map((s) => s.scenarioId)).size === r.scenarios.length,
    { message: "scenarioId values must be unique", path: ["scenarios"] },
  );

export type StressRequest = z.infer<typeof stressRequestSchema>;

/** Resolved per-scenario effective assumptions (verbatim-echoable). */
export const resolvedScenarioSchema = stressScenarioSchema
  .extend({
    spreadPips: z.number().finite().min(0),
    slippagePips: z.number().finite().min(0),
    commissionPips: z.number().finite().min(0),
    latencyBars: z.number().int().min(1),
    kind: z.literal("stressed"),
  })
  .strict();

export type ResolvedScenario = z.infer<typeof resolvedScenarioSchema>;

export class StressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StressError";
  }
}

/** Resolve multipliers against the base assumptions (deterministic). */
export function resolveStressScenarios(input: StressRequest): ResolvedScenario[] {
  const r = stressRequestSchema.parse(input);
  return r.scenarios.map((s) =>
    resolvedScenarioSchema.parse({
      ...s,
      spreadPips: r.baseSpreadPips * s.spreadMultiplier,
      slippagePips: r.baseSlippagePips * s.slippageMultiplier,
      commissionPips: r.baseCommissionPips * s.commissionMultiplier,
      latencyBars: r.baseLatencyBars + s.extraLatencyBars,
      kind: "stressed",
    }),
  );
}

/**
 * Seeded deterministic shuffle (Fisher-Yates over a counter-hashed LCG
 * stream). The stream hashes `${seed}:${counter}` with FNV-1a so TS and
 * Python produce the same permutation for the same seed.
 */
export function seededShuffle<T>(values: readonly T[], seed: string, stream: string): T[] {
  if (seed.length < 1) throw new StressError("seed must be non-empty");
  if (stream.length < 1) throw new StressError("stream must be non-empty");
  const out = [...values];
  const rand = lcgStream(`${seed}:${stream}`);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function lcgStream(key: string): () => number {
  let state = fnv1a32(key);
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Max drawdown of a cumulative PnL path starting at `initialEquity`. */
export function pathMaxDrawdown(pnls: readonly number[], initialEquity: number): number {
  if (!(initialEquity > 0)) throw new StressError("initialEquity must be > 0");
  let peak = initialEquity;
  let equity = initialEquity;
  let maxDd = 0;
  for (const pnl of pnls) {
    if (!Number.isFinite(pnl)) throw new StressError("pnl path must be finite");
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Block-reshuffle Monte Carlo over a per-trade PnL path (deterministic). */
export function monteCarloDrawdowns(
  pnls: readonly number[],
  initialEquity: number,
  samples: number,
  blocks: number,
  seed: string,
): number[] {
  if (pnls.length === 0) throw new StressError("pnl path must be non-empty");
  if (!Number.isInteger(samples) || samples < 1 || samples > 10_000) {
    throw new StressError("samples must be an integer in 1..10000");
  }
  if (!Number.isInteger(blocks) || blocks < 1) {
    throw new StressError("blocks must be an integer >= 1");
  }
  const chunks = splitBlocks(pnls, blocks);
  const out: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const order = seededShuffle(chunks, seed, `mc:${s}`);
    out.push(pathMaxDrawdown(order.flat(), initialEquity));
  }
  return out;
}

function splitBlocks<T>(values: readonly T[], blocks: number): T[][] {
  const n = Math.min(blocks, values.length);
  const size = Math.ceil(values.length / n);
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push([...values.slice(i, i + size)]);
  return out;
}
