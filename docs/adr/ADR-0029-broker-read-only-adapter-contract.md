# ADR-0029: Provider-neutral broker read-only adapter contract and execution exclusion

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P15 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC time policy), ADR-0005 (live trading OFF by default), ADR-0010 (market data provider abstraction), ADR-0021 (paper broker and reconciliation), ADR-0022 (independent risk engine)

## Context

Phase P15 requires a provider-neutral broker read-only adapter contract covering account balances, quotes, open positions, active orders (read-only), historical trades/deals, and adapter health. A hard architectural boundary is required: strategy and LLM code must never call a broker directly; write operations (order submission, order cancellation, position closing) must be physically absent and unreachable from read-only services; and all internal timestamps must be UTC.

## Decision

1. **Provider-neutral typed contract**: Defined in `contracts/src/broker/contract.ts` with Zod schemas for boundary validation:
   - `BrokerAccount`: accountId, brokerId, accountNumber, currency, balance, equity, margin, freeMargin, marginLevel, leverage, isDemo, serverName, company, updatedAtUtc.
   - `BrokerQuote`: symbol, bid, ask, spread, atUtc (bid <= ask enforced).
   - `BrokerPosition`: positionId, brokerTicket, symbol, direction (`long|short`), quantityLots, quantityUnits, openPrice, currentPrice, sl, tp, swap, commission, unrealizedProfit, openedAtUtc.
   - `BrokerOrderRead`: orderId, brokerTicket, symbol, side (`buy|sell`), orderType (`market|limit|stop`), state (`open|filled|cancelled|rejected|expired`), lotsInitial, lotsCurrent, unitsInitial, unitsCurrent, openPrice, sl, tp, createdAtUtc, expiresAtUtc.
   - `BrokerTrade`: tradeId, brokerTicket, orderTicket, positionTicket, symbol, side (`buy|sell`), entryType (`in|out|inout`), quantityLots, quantityUnits, price, commission, swap, realizedProfit, closedAtUtc.
   - `BrokerHealth`: adapterName, brokerId, status (`healthy|degraded|unhealthy`), connected, latencyMs, lastHeartbeatUtc, message, details.
2. **Read-only interface**: `BrokerReadOnlyAdapter` defines strictly read queries: `getAccount()`, `getQuotes(symbols)`, `getPositions()`, `getOrders()`, `getTrades(query)`, `getHealth()`. Write methods are omitted by definition.
3. **Execution exclusion**: `BrokerReadOnlyService` wraps any adapter, validates returned data fail-closed with Zod, checks at construction that no write methods are exposed on the adapter, and proxies calls with an interceptor that throws `BrokerReadOnlyViolationError` if any forbidden write method (e.g. `createOrder`, `submitOrder`, `order_send`) is accessed dynamically.
4. **All timestamps UTC**: All time fields are pinned to `utcInstantSchema` (ISO 8601 UTC).

## Consequences

- Read-only consumers (sync service, position monitor, UI dashboards) have access to canonical broker representations without risk of executing trades.
- Concrete broker adapters (MT5, fixtures) implement the same provider-neutral interface.
- CI and contract test suites can assert that execution authority is unbreachable from read-only components.

## Verification

- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/broker-contract.test.ts` passes (20 tests).
- All 30 test suites in `@fdbtrade/contracts` pass (446 tests).
- CI contract suite `python3 -m unittest tests.test_ci_contracts` verifies ADR numbering and format.
