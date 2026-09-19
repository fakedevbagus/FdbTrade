/**
 * MT5 Read-Only Adapter (P15-02).
 *
 * Implements canonical BrokerReadOnlyAdapter for MetaTrader 5 demo and live accounts.
 * Communicates via an isolated, pluggable Mt5Transport interface (with a built-in
 * FixtureMt5Transport for test and CI environments where the native MT5 terminal is absent).
 *
 * HARD BOUNDARY:
 * - NO `order_send` or order creation calls (strictly read-only).
 * - All incoming timestamps normalized to ISO 8601 UTC.
 * - Explicit typed errors on transport/payload failures.
 */
import {
  type BrokerAccount,
  type BrokerHealth,
  type BrokerOrderRead,
  type BrokerOrderSide,
  type BrokerOrderState,
  type BrokerOrderType,
  type BrokerPosition,
  type BrokerPositionDirection,
  type BrokerQuote,
  type BrokerReadOnlyAdapter,
  type BrokerTrade,
  type BrokerTradesQuery,
} from "./contract";
import {
  MT5_DEMO_ACCOUNT_FIXTURE,
  MT5_DEMO_DEALS_FIXTURE,
  MT5_DEMO_ORDERS_FIXTURE,
  MT5_DEMO_POSITIONS_FIXTURE,
  MT5_DEMO_TICKS_FIXTURE,
  type RawMt5AccountInfo,
  type RawMt5Deal,
  type RawMt5Order,
  type RawMt5Position,
  type RawMt5Tick,
} from "./mt5Fixtures";

export class Mt5TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mt5TransportError";
  }
}

export class Mt5ConnectionError extends Mt5TransportError {
  constructor(message: string) {
    super(message);
    this.name = "Mt5ConnectionError";
  }
}

export class Mt5TimeoutError extends Mt5TransportError {
  constructor(message: string) {
    super(message);
    this.name = "Mt5TimeoutError";
  }
}

export class Mt5PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mt5PayloadError";
  }
}

/**
 * Isolated transport boundary for MT5 bridge communication.
 * Write operations (order_send) are NOT present in this interface.
 */
export interface Mt5Transport {
  fetchAccountInfo(): Promise<RawMt5AccountInfo>;
  fetchSymbolTick(symbol: string): Promise<RawMt5Tick | null>;
  fetchPositions(): Promise<RawMt5Position[]>;
  fetchOrders(): Promise<RawMt5Order[]>;
  fetchDeals(fromEpochSec?: number, toEpochSec?: number): Promise<RawMt5Deal[]>;
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
}


/**
 * Deterministic in-memory fixture transport for MT5 data.
 */
export class FixtureMt5Transport implements Mt5Transport {
  private account: RawMt5AccountInfo;
  private ticks: Record<string, RawMt5Tick>;
  private positions: RawMt5Position[];
  private orders: RawMt5Order[];
  private deals: RawMt5Deal[];
  private isConnected: boolean;
  private latencyMs: number;

  constructor(options?: {
    account?: RawMt5AccountInfo;
    ticks?: Record<string, RawMt5Tick>;
    positions?: RawMt5Position[];
    orders?: RawMt5Order[];
    deals?: RawMt5Deal[];
    connected?: boolean;
    latencyMs?: number;
  }) {
    this.account = options?.account ?? { ...MT5_DEMO_ACCOUNT_FIXTURE };
    this.ticks = options?.ticks ?? { ...MT5_DEMO_TICKS_FIXTURE };
    this.positions = options?.positions ?? [...MT5_DEMO_POSITIONS_FIXTURE];
    this.orders = options?.orders ?? [...MT5_DEMO_ORDERS_FIXTURE];
    this.deals = options?.deals ?? [...MT5_DEMO_DEALS_FIXTURE];
    this.isConnected = options?.connected ?? true;
    this.latencyMs = options?.latencyMs ?? 5.0;
  }

  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    if (!this.isConnected) {
      return { ok: false, latencyMs: 0 };
    }
    return { ok: true, latencyMs: this.latencyMs };
  }

  async fetchAccountInfo(): Promise<RawMt5AccountInfo> {
    if (!this.isConnected) {
      throw new Mt5ConnectionError("MT5 bridge is disconnected");
    }
    return { ...this.account };
  }

  async fetchSymbolTick(symbol: string): Promise<RawMt5Tick | null> {
    if (!this.isConnected) {
      throw new Mt5ConnectionError("MT5 bridge is disconnected");
    }
    const tick = this.ticks[symbol];
    return tick ? { ...tick } : null;
  }

  async fetchPositions(): Promise<RawMt5Position[]> {
    if (!this.isConnected) {
      throw new Mt5ConnectionError("MT5 bridge is disconnected");
    }
    return this.positions.map((p) => ({ ...p }));
  }

  async fetchOrders(): Promise<RawMt5Order[]> {
    if (!this.isConnected) {
      throw new Mt5ConnectionError("MT5 bridge is disconnected");
    }
    return this.orders.map((o) => ({ ...o }));
  }

  async fetchDeals(fromEpochSec?: number, toEpochSec?: number): Promise<RawMt5Deal[]> {
    if (!this.isConnected) {
      throw new Mt5ConnectionError("MT5 bridge is disconnected");
    }
    let filtered = this.deals;
    if (typeof fromEpochSec === "number") {
      filtered = filtered.filter((d) => d.time >= fromEpochSec);
    }
    if (typeof toEpochSec === "number") {
      filtered = filtered.filter((d) => d.time <= toEpochSec);
    }
    return filtered.map((d) => ({ ...d }));
  }
}

/** Round number to 6 decimal places. */
function round6(val: number): number {
  return Math.round(val * 1e6) / 1e6;
}

/** Convert MT5 epoch seconds into canonical ISO 8601 UTC string. */
function mt5EpochToUtc(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) {
    throw new Mt5PayloadError(`Invalid MT5 epoch timestamp: ${epochSec}`);
  }
  return new Date(epochSec * 1000).toISOString();
}



export interface Mt5AdapterOptions {
  brokerId?: string;
  adapterName?: string;
  lotSize?: number; // default 100,000 units per lot
}

export class Mt5ReadOnlyAdapter implements BrokerReadOnlyAdapter {
  readonly adapterName: string;
  readonly brokerId: string;
  private readonly transport: Mt5Transport;
  private readonly lotSize: number;

  constructor(transport: Mt5Transport, options?: Mt5AdapterOptions) {
    if (!transport || typeof transport !== "object") {
      throw new Mt5TransportError("Invalid Mt5Transport supplied");
    }
    this.transport = transport;
    this.adapterName = options?.adapterName ?? "mt5-read-only-adapter";
    this.brokerId = options?.brokerId ?? "mt5-demo";
    this.lotSize = options?.lotSize ?? 100000;
  }

  async getAccount(): Promise<BrokerAccount> {
    const raw = await this.transport.fetchAccountInfo();
    if (!raw || typeof raw.login !== "number" || !raw.currency) {
      throw new Mt5PayloadError("Malformed MT5 account payload: missing login or currency");
    }
    return {
      accountId: `brkacc_mt5_${raw.login}`,
      brokerId: this.brokerId,
      accountNumber: String(raw.login),
      currency: raw.currency.toUpperCase(),
      balance: round6(raw.balance),
      equity: round6(raw.equity),
      margin: Math.max(0, round6(raw.margin)),
      freeMargin: round6(raw.margin_free),
      marginLevel: raw.margin > 0 ? round6(raw.margin_level) : null,
      leverage: Math.max(1, Math.floor(raw.leverage)),
      isDemo: raw.trade_mode === 0,
      serverName: raw.server || "unknown",
      company: raw.company || null,
      updatedAtUtc: raw.updated_at ? mt5EpochToUtc(raw.updated_at) : new Date().toISOString(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const result: Record<string, BrokerQuote> = {};
    for (const sym of symbols) {
      const raw = await this.transport.fetchSymbolTick(sym);
      if (!raw) continue;
      if (raw.bid <= 0 || raw.ask <= 0 || raw.ask < raw.bid) {
        throw new Mt5PayloadError(`Invalid bid/ask spread for symbol ${sym}`);
      }
      result[sym] = {
        symbol: raw.symbol,
        bid: raw.bid,
        ask: raw.ask,
        spread: round6(Math.max(0, raw.ask - raw.bid)),
        atUtc: mt5EpochToUtc(raw.time),
      };
    }
    return result;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rawList = await this.transport.fetchPositions();
    return rawList.map((raw) => {
      const direction: BrokerPositionDirection = raw.type === 0 ? "long" : "short";
      return {
        positionId: `brkpos_mt5_${raw.ticket}`,
        brokerTicket: String(raw.ticket),
        symbol: raw.symbol,
        direction,
        quantityLots: round6(raw.volume),
        quantityUnits: round6(raw.volume * this.lotSize),
        openPrice: raw.price_open,
        currentPrice: raw.price_current,
        sl: raw.sl > 0 ? raw.sl : null,
        tp: raw.tp > 0 ? raw.tp : null,
        swap: round6(raw.swap),
        commission: round6(raw.commission),
        unrealizedProfit: round6(raw.profit),
        openedAtUtc: mt5EpochToUtc(raw.time),
        comment: raw.comment ?? null,
        magic: typeof raw.magic === "number" ? raw.magic : null,
      };
    });
  }
  async getOrders(): Promise<BrokerOrderRead[]> {
    const rawList = await this.transport.fetchOrders();
    return rawList.map((raw) => {
      const side: BrokerOrderSide =
        raw.type === 0 || raw.type === 2 || raw.type === 4 ? "buy" : "sell";
      let orderType: BrokerOrderType = "market";
      if (raw.type === 2 || raw.type === 3) orderType = "limit";
      else if (raw.type === 4 || raw.type === 5) orderType = "stop";

      let state: BrokerOrderState = "open";
      if (raw.state === 2) state = "cancelled";
      else if (raw.state === 4) state = "filled";
      else if (raw.state === 5) state = "rejected";
      else if (raw.state === 6) state = "expired";

      return {
        orderId: `brkord_mt5_${raw.ticket}`,
        brokerTicket: String(raw.ticket),
        symbol: raw.symbol,
        side,
        orderType,
        state,
        lotsInitial: round6(raw.volume_initial),
        lotsCurrent: round6(raw.volume_current),
        unitsInitial: round6(raw.volume_initial * this.lotSize),
        unitsCurrent: round6(raw.volume_current * this.lotSize),
        openPrice: raw.price_open,
        sl: raw.sl > 0 ? raw.sl : null,
        tp: raw.tp > 0 ? raw.tp : null,
        createdAtUtc: mt5EpochToUtc(raw.time_setup),
        expiresAtUtc:
          raw.time_expiration && raw.time_expiration > 0
            ? mt5EpochToUtc(raw.time_expiration)
            : null,
        comment: raw.comment ?? null,
        magic: typeof raw.magic === "number" ? raw.magic : null,
      };
    });
  }

  async getTrades(query?: BrokerTradesQuery): Promise<BrokerTrade[]> {
    const fromSec = query?.sinceUtc
      ? Math.floor(new Date(query.sinceUtc).getTime() / 1000)
      : undefined;
    const toSec = query?.untilUtc
      ? Math.floor(new Date(query.untilUtc).getTime() / 1000)
      : undefined;

    const rawList = await this.transport.fetchDeals(fromSec, toSec);
    let trades: BrokerTrade[] = rawList.map((raw) => {
      const side: BrokerOrderSide = raw.type === 0 ? "buy" : "sell";
      const entryType = raw.entry === 0 ? "in" : raw.entry === 1 ? "out" : "inout";
      return {
        tradeId: `brktrd_mt5_${raw.ticket}`,
        brokerTicket: String(raw.ticket),
        orderTicket: raw.order > 0 ? String(raw.order) : null,
        positionTicket: raw.position_id > 0 ? String(raw.position_id) : null,
        symbol: raw.symbol,
        side,
        entryType,
        quantityLots: round6(raw.volume),
        quantityUnits: round6(raw.volume * this.lotSize),
        price: raw.price,
        commission: round6(raw.commission),
        swap: round6(raw.swap),
        realizedProfit: round6(raw.profit),
        closedAtUtc: mt5EpochToUtc(raw.time),
        comment: raw.comment ?? null,
        magic: typeof raw.magic === "number" ? raw.magic : null,
      };
    });

    if (query?.symbol) {
      trades = trades.filter((t) => t.symbol === query.symbol);
    }
    if (typeof query?.limit === "number" && query.limit > 0) {
      trades = trades.slice(0, query.limit);
    }
    return trades;
  }

  async getHealth(): Promise<BrokerHealth> {
    const pingRes = await this.transport.ping();
    const now = new Date().toISOString();
    return {
      adapterName: this.adapterName,
      brokerId: this.brokerId,
      status: pingRes.ok ? "healthy" : "unhealthy",
      connected: pingRes.ok,
      latencyMs: pingRes.latencyMs,
      lastHeartbeatUtc: now,
      message: pingRes.ok ? "MT5 bridge operational" : "MT5 bridge unreachable",
      details: {
        pingOk: pingRes.ok,
        lotSize: this.lotSize,
      },
    };
  }

}

