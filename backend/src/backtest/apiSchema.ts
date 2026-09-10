/**
 * Backtest API request validation (P08-05).
 *
 * Strict zod schemas at the boundary: the run-request body must satisfy the
 * canonical run-config contract (grid-aligned period, latency >= 1, cost
 * fields >= 0, maxFillFraction in (0,1]) and the API's own rules (subject
 * restricted to the served `noop` placeholder; explicit createdAtUtc). Fail
 * closed — unknown keys reject.
 */
import { z } from "zod";

import {
  backtestFillPolicySchema,
  TIMEFRAMES,
} from "@fdbtrade/contracts";

export const backtestRunRequestSchema = z
  .object({
    instrument: z.string().regex(/^[A-Z0-9]{2,16}$/),
    timeframe: z.enum(TIMEFRAMES),
    periodStartUtc: z.iso.datetime({ offset: false, precision: 3 }),
    periodEndUtc: z.iso.datetime({ offset: false, precision: 3 }),
    initialEquity: z.number().finite().positive(),
    warmupBars: z.number().int().min(0),
    fillPolicy: backtestFillPolicySchema,
    seed: z.string().min(1).max(128),
    /** Only the served placeholder subject is accepted (fail closed). */
    subject: z.literal("noop"),
    /** Explicit manifest timestamp (UTC) — no wall clock anywhere. */
    createdAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type BacktestRunRequestInput = z.infer<typeof backtestRunRequestSchema>;
