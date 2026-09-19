/**
 * Provider-neutral broker read-only adapter contracts (P15-01, ADR-0029).
 *
 * Provides typed data contracts and schema validation for:
 * - Broker account metadata and balances (balance, equity, margin, leverage).
 * - Live/cached quotes (bid, ask, spread, time).
 * - Open positions (symbol, direction, volume, openPrice, sl, tp, swap, profit).
 * - Read-only orders (state, type, volumeInitial, volumeCurrent, openPrice).
 * - Historical trades / deals (entry type, price, profit, commission, swap).
 * - Broker adapter health status.
 *
 * HARD BOUNDARY:
 * - Strategy code must NEVER call a broker directly (ADR-0003, ADR-0005).
 * - Live execution is OFF by default.
 * - This contract and read-only service wrapper physically EXCLUDES write
 *   operations (no createOrder, order_send, modifyOrder, cancelOrder).
 * - All internal timestamps are UTC (ADR-0004).
 * - Deterministic validation fail-closed on malformed input.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const BROKER_CONTRACT_ID = "broker-contract";
export const BROKER_CONTRACT_VERSION = "1.0.0";

export class BrokerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerContractError";
  }
}

export class BrokerReadOnlyViolationError extends Error {
  constructor(action: string) {
    super(`Write operation '${action}' is strictly forbidden on read-only broker adapter/service`);
    this.name = "BrokerReadOnlyViolationError";
  }
}

// ---------------------------------------------------------------------------
// 1. Account Schema & Types
// ---------------------------------------------------------------------------

export const brokerAccountSchema = z
  .object({
    accountId: z.string().min(1),
    brokerId: z.string().min(1),
    accountNumber: z.string().min(1),
    currency: z.string().length(3).regex(/^[A-Z]+$/),
    balance: z.number().finite(),
    equity: z.number().finite(),
    margin: z.number().finite().min(0),
    freeMargin: z.number().finite(),
    marginLevel: z.number().finite().min(0).nullable(),
    leverage: z.number().int().min(1),
    isDemo: z.boolean(),
    serverName: z.string().min(1),
    company: z.string().nullable().default(null),
    updatedAtUtc: utcInstantSchema,
  })
  .strict();

export type BrokerAccount = z.infer<typeof brokerAccountSchema>;

// ---------------------------------------------------------------------------
// 2. Quote Schema & Types
// ---------------------------------------------------------------------------

export const brokerQuoteSchema = z
  .object({
    symbol: z.string().min(1),
    bid: z.number().finite().positive(),
    ask: z.number().finite().positive(),
    spread: z.number().finite().min(0),
    atUtc: utcInstantSchema,
  })
  .strict()
  .refine((data) => data.ask >= data.bid, {
    message: "ask price must be greater than or equal to bid price",
    path: ["ask"],
  });

export type BrokerQuote = z.infer<typeof brokerQuoteSchema>;


// ---------------------------------------------------------------------------
// 3. Position Schema & Types
// ---------------------------------------------------------------------------

export const brokerPositionDirectionSchema = z.enum(["long", "short"]);
export type BrokerPositionDirection = z.infer<typeof brokerPositionDirectionSchema>;

export const brokerPositionSchema = z
  .object({
    positionId: z.string().min(1),
    brokerTicket: z.string().min(1),
    symbol: z.string().min(1),
    direction: brokerPositionDirectionSchema,
    quantityLots: z.number().finite().positive(),
    quantityUnits: z.number().finite().positive(),
    openPrice: z.number().finite().positive(),
    currentPrice: z.number().finite().positive(),
    sl: z.number().finite().positive().nullable(),
    tp: z.number().finite().positive().nullable(),
    swap: z.number().finite(),
    commission: z.number().finite(),
    unrealizedProfit: z.number().finite(),
    openedAtUtc: utcInstantSchema,
    comment: z.string().nullable().default(null),
    magic: z.number().int().nullable().default(null),
  })
  .strict();

export type BrokerPosition = z.infer<typeof brokerPositionSchema>;

// ---------------------------------------------------------------------------
// 4. Order Read Schema & Types
// ---------------------------------------------------------------------------

export const brokerOrderSideSchema = z.enum(["buy", "sell"]);
export type BrokerOrderSide = z.infer<typeof brokerOrderSideSchema>;

export const brokerOrderTypeSchema = z.enum(["market", "limit", "stop"]);
export type BrokerOrderType = z.infer<typeof brokerOrderTypeSchema>;

export const brokerOrderStateSchema = z.enum([
  "open",
  "filled",
  "cancelled",
  "rejected",
  "expired",
]);
export type BrokerOrderState = z.infer<typeof brokerOrderStateSchema>;

export const brokerOrderReadSchema = z
  .object({
    orderId: z.string().min(1),
    brokerTicket: z.string().min(1),
    symbol: z.string().min(1),
    side: brokerOrderSideSchema,
    orderType: brokerOrderTypeSchema,
    state: brokerOrderStateSchema,
    lotsInitial: z.number().finite().positive(),
    lotsCurrent: z.number().finite().min(0),
    unitsInitial: z.number().finite().positive(),
    unitsCurrent: z.number().finite().min(0),
    openPrice: z.number().finite().positive(),
    sl: z.number().finite().positive().nullable(),
    tp: z.number().finite().positive().nullable(),
    createdAtUtc: utcInstantSchema,
    expiresAtUtc: utcInstantSchema.nullable().default(null),
    comment: z.string().nullable().default(null),
    magic: z.number().int().nullable().default(null),
  })
  .strict();

export type BrokerOrderRead = z.infer<typeof brokerOrderReadSchema>;

// ---------------------------------------------------------------------------
// 5. Historical Trade / Deal Schema & Types
// ---------------------------------------------------------------------------

export const brokerDealEntryTypeSchema = z.enum(["in", "out", "inout"]);
export type BrokerDealEntryType = z.infer<typeof brokerDealEntryTypeSchema>;

export const brokerTradeSchema = z
  .object({
    tradeId: z.string().min(1),
    brokerTicket: z.string().min(1),
    orderTicket: z.string().nullable().default(null),
    positionTicket: z.string().nullable().default(null),
    symbol: z.string().min(1),
    side: brokerOrderSideSchema,
    entryType: brokerDealEntryTypeSchema,
    quantityLots: z.number().finite().positive(),
    quantityUnits: z.number().finite().positive(),
    price: z.number().finite().positive(),
    commission: z.number().finite(),
    swap: z.number().finite(),
    realizedProfit: z.number().finite(),
    closedAtUtc: utcInstantSchema,
    comment: z.string().nullable().default(null),
    magic: z.number().int().nullable().default(null),
  })
  .strict();

export type BrokerTrade = z.infer<typeof brokerTradeSchema>;



// ---------------------------------------------------------------------------
// 6. Broker Health Schema & Types
// ---------------------------------------------------------------------------

export const brokerHealthStatusSchema = z.enum(["healthy", "degraded", "unhealthy"]);
export type BrokerHealthStatus = z.infer<typeof brokerHealthStatusSchema>;

export const brokerHealthSchema = z
  .object({
    adapterName: z.string().min(1),
    brokerId: z.string().min(1),
    status: brokerHealthStatusSchema,
    connected: z.boolean(),
    latencyMs: z.number().finite().min(0),
    lastHeartbeatUtc: utcInstantSchema,
    message: z.string().nullable().default(null),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type BrokerHealth = z.infer<typeof brokerHealthSchema>;

// ---------------------------------------------------------------------------
// 7. Query Parameters for Trades
// ---------------------------------------------------------------------------

export const brokerTradesQuerySchema = z
  .object({
    sinceUtc: utcInstantSchema.optional(),
    untilUtc: utcInstantSchema.optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(10000).optional(),
  })
  .strict();

export type BrokerTradesQuery = z.infer<typeof brokerTradesQuerySchema>;

// ---------------------------------------------------------------------------
// 8. Provider-Neutral Read-Only Broker Adapter Interface
// ---------------------------------------------------------------------------

/**
 * Pure read-only broker adapter contract.
 * Note: Write operations (`createOrder`, `order_send`, `modifyOrder`, `cancelOrder`)
 * are PHYSICALLY ABSENT from this interface.
 */
export interface BrokerReadOnlyAdapter {
  readonly adapterName: string;
  readonly brokerId: string;

  /** Fetch account balance, equity, margin and leverage. */
  getAccount(): Promise<BrokerAccount>;

  /** Fetch latest quotes for given symbols. */
  getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>>;

  /** Fetch currently open positions. */
  getPositions(): Promise<BrokerPosition[]>;

  /** Fetch pending/active read-only orders. */
  getOrders(): Promise<BrokerOrderRead[]>;

  /** Fetch historical trade/deal records. */
  getTrades(query?: BrokerTradesQuery): Promise<BrokerTrade[]>;

  /** Fetch adapter connection and latency health status. */
  getHealth(): Promise<BrokerHealth>;
}

// ---------------------------------------------------------------------------
// 9. Read-Only Service Wrapper (Enforces Boundary & Fail-Closed Validation)
// ---------------------------------------------------------------------------

/** Forbidden execution method names that must never be accessible. */
export const FORBIDDEN_BROKER_WRITE_METHODS = [
  "createOrder",
  "submitOrder",
  "placeOrder",
  "sendOrder",
  "order_send",
  "orderSend",
  "modifyOrder",
  "cancelOrder",
  "closePosition",
  "closeAll",
  "executeOrder",
] as const;

/**
 * Wraps any BrokerReadOnlyAdapter to provide:
 * 1. Strict schema validation on all inputs and outputs.
 * 2. Hard runtime interceptor that prevents any dynamic invocation of write operations.
 */
export class BrokerReadOnlyService {
  private readonly adapter: BrokerReadOnlyAdapter;

  constructor(adapter: BrokerReadOnlyAdapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new BrokerContractError("Invalid adapter supplied to BrokerReadOnlyService");
    }

    // Safety verify: adapter must not expose write methods
    for (const forbidden of FORBIDDEN_BROKER_WRITE_METHODS) {
      if (forbidden in adapter) {
        throw new BrokerReadOnlyViolationError(forbidden);
      }
    }

    this.adapter = adapter;

    // Return a proxy that blocks any dynamic write calls
    return new Proxy(this, {
      get(target, prop, receiver) {
        const propStr = String(prop);
        if (FORBIDDEN_BROKER_WRITE_METHODS.includes(propStr as any)) {
          throw new BrokerReadOnlyViolationError(propStr);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  get adapterName(): string {
    return this.adapter.adapterName;
  }

  get brokerId(): string {
    return this.adapter.brokerId;
  }

  async getAccount(): Promise<BrokerAccount> {
    const raw = await this.adapter.getAccount();
    return brokerAccountSchema.parse(raw);
  }

  async getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>> {
    if (!Array.isArray(symbols)) {
      throw new BrokerContractError("Symbols must be an array of strings");
    }
    const rawMap = await this.adapter.getQuotes(symbols);
    const validated: Record<string, BrokerQuote> = {};
    for (const [sym, quote] of Object.entries(rawMap)) {
      validated[sym] = brokerQuoteSchema.parse(quote);
    }
    return validated;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rawList = await this.adapter.getPositions();
    if (!Array.isArray(rawList)) {
      throw new BrokerContractError("Positions must be an array");
    }
    return rawList.map((pos) => brokerPositionSchema.parse(pos));
  }

  async getOrders(): Promise<BrokerOrderRead[]> {
    const rawList = await this.adapter.getOrders();
    if (!Array.isArray(rawList)) {
      throw new BrokerContractError("Orders must be an array");
    }
    return rawList.map((ord) => brokerOrderReadSchema.parse(ord));
  }

  async getTrades(query?: BrokerTradesQuery): Promise<BrokerTrade[]> {
    const validatedQuery = query ? brokerTradesQuerySchema.parse(query) : undefined;
    const rawList = await this.adapter.getTrades(validatedQuery);
    if (!Array.isArray(rawList)) {
      throw new BrokerContractError("Trades must be an array");
    }
    return rawList.map((trade) => brokerTradeSchema.parse(trade));
  }

  async getHealth(): Promise<BrokerHealth> {
    const raw = await this.adapter.getHealth();
    return brokerHealthSchema.parse(raw);
  }
}

