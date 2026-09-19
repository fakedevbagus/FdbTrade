/**
 * Demo execution adapter contract and guarded service implementation (P16-01, ADR-0030).
 *
 * Exposes order submission ONLY when explicitly guarded:
 * - Requires DemoExecutionGuard with demoExecutionEnabled=true
 * - Rejects live broker accounts, live servers, live endpoints
 * - Protects all boundaries with strict schema validation
 */
import { z } from "zod";

import type {
  BrokerAccount,
  BrokerHealth,
  BrokerOrderRead,
  BrokerPosition,
  BrokerQuote,
  BrokerReadOnlyAdapter,
  BrokerTrade,
  BrokerTradesQuery,
} from "../broker/contract";
import {
  type DemoOrderExecutionResult,
  type DemoOrderIntent,
  demoOrderExecutionResultSchema,
  demoOrderIntentSchema,
} from "./contract";
import { DemoExecutionGuard, DemoMisconfigurationError } from "./guard";

// ---------------------------------------------------------------------------
// Demo Execution Wire Transport Interface
// ---------------------------------------------------------------------------

export interface DemoWireTransport {
  sendDemoOrder(
    clientOrderId: string,
    intent: DemoOrderIntent,
  ): Promise<{
    brokerTicket: string;
    status: "submitted" | "acknowledged" | "filled" | "rejected";
    filledUnits: number;
    price: number | null;
    rejectReason?: string;
  }>;
  cancelDemoOrder(
    clientOrderId: string,
    brokerTicket?: string,
  ): Promise<{
    brokerTicket?: string;
    status: "cancelled" | "rejected";
    rejectReason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Demo Execution Adapter Interface
// ---------------------------------------------------------------------------
// Guarded Demo Execution Service
// ---------------------------------------------------------------------------

export class DemoExecutionService {
  private readonly readOnlyAdapter: BrokerReadOnlyAdapter;
  private readonly guard: DemoExecutionGuard;
  private readonly wireTransport?: DemoWireTransport;

  constructor(options: {
    readOnlyAdapter: BrokerReadOnlyAdapter;
    guard: DemoExecutionGuard;
    wireTransport?: DemoWireTransport;
  }) {
    if (!options.readOnlyAdapter || typeof options.readOnlyAdapter !== "object") {
      throw new DemoMisconfigurationError("readOnlyAdapter is required");
    }
    if (!options.guard || !(options.guard instanceof DemoExecutionGuard)) {
      throw new DemoMisconfigurationError("DemoExecutionGuard is required");
    }

    this.readOnlyAdapter = options.readOnlyAdapter;
    this.guard = options.guard;
    this.wireTransport = options.wireTransport;
  }

  get adapterName(): string {
    return `demo-execution(${this.readOnlyAdapter.adapterName})`;
  }

  get brokerId(): string {
    return this.readOnlyAdapter.brokerId;
  }

  getGuard(): DemoExecutionGuard {
    return this.guard;
  }

  // Delegated read methods
  async getAccount(): Promise<BrokerAccount> {
    return this.readOnlyAdapter.getAccount();
  }

  async getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>> {
    return this.readOnlyAdapter.getQuotes(symbols);
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.readOnlyAdapter.getPositions();
  }

  async getOrders(): Promise<BrokerOrderRead[]> {
    return this.readOnlyAdapter.getOrders();
  }

  async getTrades(query?: BrokerTradesQuery): Promise<BrokerTrade[]> {
    return this.readOnlyAdapter.getTrades(query);
  }

  async getHealth(): Promise<BrokerHealth> {
    return this.readOnlyAdapter.getHealth();
  }

  /**
   * Guarded order submission for demo environments.
   */
  async submitDemoOrder(
    clientOrderId: string,
    rawIntent: DemoOrderIntent,
  ): Promise<DemoOrderExecutionResult> {
    // 1. Validate intent schema
    const intent = demoOrderIntentSchema.parse(rawIntent);

    // 2. Startup guard validation
    this.guard.validateStartup();

    // 3. Fetch broker account and validate account guard
    const account = await this.readOnlyAdapter.getAccount();
    this.guard.validateBrokerAccount(account);
    this.guard.assertCanSubmitOrder(account, {
      volumeUnits: intent.volumeUnits,
      symbol: intent.symbol,
    });

    const nowUtc = new Date().toISOString();

    // 4. Send via wire transport if available
    if (this.wireTransport) {
      const wireResult = await this.wireTransport.sendDemoOrder(clientOrderId, intent);
      const remaining = Math.max(0, intent.volumeUnits - wireResult.filledUnits);

      const result: DemoOrderExecutionResult = {
        clientOrderId,
        intentId: intent.intentId,
        brokerTicket: wireResult.brokerTicket,
        symbol: intent.symbol,
        side: intent.side,
        orderType: intent.orderType,
        status: wireResult.status,
        volumeRequested: intent.volumeUnits,
        volumeFilled: wireResult.filledUnits,
        remainingUnits: remaining,
        averagePrice: wireResult.price,
        rejectReason: wireResult.rejectReason ?? null,
        submittedAtUtc: nowUtc,
        updatedAtUtc: nowUtc,
      };

      return demoOrderExecutionResultSchema.parse(result);
    }

    // Default mock wire acknowledgment
    const defaultResult: DemoOrderExecutionResult = {
      clientOrderId,
      intentId: intent.intentId,
      brokerTicket: `mock_ticket_${clientOrderId}`,
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      status: "acknowledged",
      volumeRequested: intent.volumeUnits,
      volumeFilled: 0,
      remainingUnits: intent.volumeUnits,
      averagePrice: null,
      rejectReason: null,
      submittedAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };

    return demoOrderExecutionResultSchema.parse(defaultResult);
  }
}

// ---------------------------------------------------------------------------

export interface DemoExecutionAdapter extends BrokerReadOnlyAdapter {
  submitDemoOrder(
    clientOrderId: string,
    intent: DemoOrderIntent,
  ): Promise<DemoOrderExecutionResult>;
  cancelDemoOrder(
    clientOrderId: string,
    brokerTicket?: string,
  ): Promise<DemoOrderExecutionResult>;
}
