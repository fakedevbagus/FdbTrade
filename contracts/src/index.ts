/**
 * @fdbtrade/contracts — public surface (P02-01).
 *
 * Canonical market-data model shared by backend, research (Python mirror in
 * `quant/datacore`) and tests. All internal timestamps are UTC (ADR-0004).
 */
export * from "./marketdata/time";
export * from "./marketdata/instrument";
export * from "./marketdata/session";
export * from "./marketdata/quote";
export * from "./marketdata/candle";
export * from "./marketdata/registry";
export * from "./marketdata/provider";
export * from "./marketdata/dataset";
export * from "./feature/definition";
export * from "./feature/snapshot";
export * from "./regime/contract";
export * from "./regime/context";
export * from "./regime/diagnostics";
