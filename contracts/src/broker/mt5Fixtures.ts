/**
 * Deterministic fixture dataset for MT5 demo account (P15-02).
 *
 * Provides wire-level raw MT5 data representations:
 * - Account info (demo balance $100,000, 1:100 leverage).
 * - Live market ticks (EURUSD, GBPUSD, USDJPY).
 * - Open positions (EURUSD long, GBPUSD short).
 * - Active pending orders (EURUSD buy limit).
 * - Historical closed deals (EURUSD entry & exit roundtrip).
 */

export interface RawMt5AccountInfo {
  login: number;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  margin_free: number;
  margin_level: number;
  leverage: number;
  trade_mode: number; // 0 = demo, 1 = contest, 2 = real
  server: string;
  company: string;
  updated_at?: number; // epoch seconds
}

export interface RawMt5Tick {
  symbol: string;
  bid: number;
  ask: number;
  time: number; // epoch seconds
  last?: number;
  volume?: number;
}

export interface RawMt5Position {
  ticket: number;
  symbol: string;
  type: number; // 0 = BUY, 1 = SELL
  volume: number; // lots
  price_open: number;
  price_current: number;
  sl: number;
  tp: number;
  swap: number;
  commission: number;
  profit: number;
  time: number; // epoch seconds
  comment?: string;
  magic?: number;
}

export interface RawMt5Order {
  ticket: number;
  symbol: string;
  type: number; // 0=BUY, 1=SELL, 2=BUY_LIMIT, 3=SELL_LIMIT, 4=BUY_STOP, 5=SELL_STOP
  state: number; // 0=STARTED, 1=PLACED, 2=CANCELLED, 3=PARTIAL, 4=FILLED, 5=REJECTED, 6=EXPIRED
  volume_initial: number;
  volume_current: number;
  price_open: number;
  sl: number;
  tp: number;
  time_setup: number; // epoch seconds
  time_expiration?: number;
  comment?: string;
  magic?: number;
}

export interface RawMt5Deal {
  ticket: number;
  order: number;
  position_id: number;
  symbol: string;
  type: number; // 0=BUY, 1=SELL
  entry: number; // 0=IN, 1=OUT, 2=INOUT, 3=OUT_BY
  volume: number;
  price: number;
  commission: number;
  swap: number;
  profit: number;
  time: number; // epoch seconds
  comment?: string;
  magic?: number;
}

export const MT5_DEMO_ACCOUNT_FIXTURE: RawMt5AccountInfo = {
  login: 50123456,
  currency: "USD",
  balance: 100000.0,
  equity: 100450.0,
  margin: 1500.0,
  margin_free: 98950.0,
  margin_level: 6696.67,
  leverage: 100,
  trade_mode: 0, // demo
  server: "MetaQuotes-Demo",
  company: "MetaQuotes Software Corp.",
  updated_at: 1789200000,
};

export const MT5_DEMO_TICKS_FIXTURE: Record<string, RawMt5Tick> = {
  EURUSD: {
    symbol: "EURUSD",
    bid: 1.085,
    ask: 1.08515,
    time: 1789200000, // deterministic epoch
  },
  GBPUSD: {
    symbol: "GBPUSD",
    bid: 1.255,
    ask: 1.25525,
    time: 1789200000,
  },
  USDJPY: {
    symbol: "USDJPY",
    bid: 150.2,
    ask: 150.22,
    time: 1789200000,
  },
};

export const MT5_DEMO_POSITIONS_FIXTURE: RawMt5Position[] = [
  {
    ticket: 9001,
    symbol: "EURUSD",
    type: 0, // BUY -> long
    volume: 0.5,
    price_open: 1.082,
    price_current: 1.085,
    sl: 1.078,
    tp: 1.092,
    swap: -2.5,
    commission: -3.5,
    profit: 150.0,
    time: 1789190000,
    comment: "strat_trend_01",
    magic: 1001,
  },
  {
    ticket: 9002,
    symbol: "GBPUSD",
    type: 1, // SELL -> short
    volume: 1.0,
    price_open: 1.258,
    price_current: 1.255,
    sl: 1.265,
    tp: 1.245,
    swap: -5.0,
    commission: -7.0,
    profit: 300.0,
    time: 1789191000,
    comment: "strat_breakout_01",
    magic: 1002,
  },
];

export const MT5_DEMO_ORDERS_FIXTURE: RawMt5Order[] = [
  {
    ticket: 7001,
    symbol: "EURUSD",
    type: 2, // BUY_LIMIT
    state: 1, // PLACED -> open
    volume_initial: 0.25,
    volume_current: 0.25,
    price_open: 1.08,
    sl: 1.075,
    tp: 1.09,
    time_setup: 1789195000,
    time_expiration: 0,
    comment: "limit_order_01",
    magic: 1001,
  },
];

export const MT5_DEMO_DEALS_FIXTURE: RawMt5Deal[] = [
  {
    ticket: 8001,
    order: 6001,
    position_id: 8801,
    symbol: "EURUSD",
    type: 0, // BUY
    entry: 0, // ENTRY_IN
    volume: 0.5,
    price: 1.08,
    commission: -3.5,
    swap: 0,
    profit: 0,
    time: 1789150000,
    comment: "entry_deal",
    magic: 1001,
  },
  {
    ticket: 8002,
    order: 6002,
    position_id: 8801,
    symbol: "EURUSD",
    type: 1, // SELL
    entry: 1, // ENTRY_OUT
    volume: 0.5,
    price: 1.085,
    commission: -3.5,
    swap: -1.2,
    profit: 250.0,
    time: 1789160000,
    comment: "tp_exit_deal",
    magic: 1001,
  },
];
