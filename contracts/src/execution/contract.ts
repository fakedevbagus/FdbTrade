/**
 * Demo execution typed data contracts (P16-01, P16-02, ADR-0030).
 *
 * Provides schemas and types for:
 * - Demo order intents (derived with full signal/account lineage)
 * - Demo order execution results & status transitions
 * - All timestamps in UTC (ADR-0004)
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

// ---------------------------------------------------------------------------
// 1. Order Side & Types
// ---------------------------------------------------------------------------

export const demoOrderSideSchema = z.enum(["buy", "sell"]);
export type DemoOrderSide = z.infer<typeof demoOrderSideSchema>;

export const demoOrderTypeSchema = z.enum(["market", "limit", "stop"]);
export type DemoOrderType = z.infer<typeof demoOrderTypeSchema>;

export const demoOrderStatusSchema = z.enum([
  "submitted",
  "acknowledged",
  "partially_filled",
  "filled",
  "rejected",
  "investigation",
  "cancelled",
  "expired",
]);
export type DemoOrderStatus = z.infer<typeof demoOrderStatusSchema>;

// ---------------------------------------------------------------------------
// 2. Demo Order Intent Schema
// ---------------------------------------------------------------------------

export const demoOrderIntentSchema = z
  .object({
    intentId: z.string().min(1),
    signalId: z.string().min(1),
    accountId: z.string().min(1),
    symbol: z.string().min(1),
    side: demoOrderSideSchema,
    orderType: demoOrderTypeSchema,
    volumeUnits: z.number().positive(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    takeProfit: z.number().positive().optional(),
    version: z.number().int().min(1).default(1),
    createdAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoOrderIntent = z.infer<typeof demoOrderIntentSchema>;

// ---------------------------------------------------------------------------
// 3. Demo Order Execution Result Schema
// ---------------------------------------------------------------------------

export const demoOrderExecutionResultSchema = z
  .object({
    clientOrderId: z.string().min(1),
    intentId: z.string().min(1),
    brokerTicket: z.string().nullable().default(null),
    symbol: z.string().min(1),
    side: demoOrderSideSchema,
    orderType: demoOrderTypeSchema,
    status: demoOrderStatusSchema,
    volumeRequested: z.number().positive(),
    volumeFilled: z.number().min(0),
    remainingUnits: z.number().min(0),
    averagePrice: z.number().positive().nullable().default(null),
    rejectReason: z.string().nullable().default(null),
    submittedAtUtc: utcInstantSchema,
    updatedAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoOrderExecutionResult = z.infer<typeof demoOrderExecutionResultSchema>;
