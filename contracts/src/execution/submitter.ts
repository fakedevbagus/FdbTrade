/**
 * Idempotent order submission for demo execution (P16-02, ADR-0030).
 *
 * Extends DemoExecutionService with a submission ledger:
 * 1. Derives a deterministic `clientOrderId` from signal/account/intent version.
 * 2. Persists the intent (as pending) BEFORE any retry.
 * 3. If a submission record already exists with a broker response, returns the
 *    recorded response — NEVER resubmits a duplicate order to the broker.
 * 4. Records broker response after reconciliation (acknowledged/filled/rejected).
 */
import {
  type DemoOrderExecutionResult,
  type DemoOrderIntent,
  demoOrderExecutionResultSchema,
  demoOrderIntentSchema,
} from "./contract";
import {
  type DemoSubmissionStore,
  clientOrderIdFor,
} from "./idempotency";
import { DemoExecutionService } from "./adapter";

export class IdempotentDemoOrderSubmitter {
  private readonly service: DemoExecutionService;
  private readonly store: DemoSubmissionStore;
  private readonly nowFn: () => string;

  constructor(options: {
    service: DemoExecutionService;
    store: DemoSubmissionStore;
    nowFn?: () => string;
  }) {
    if (!options.service) {
      throw new Error("DemoExecutionService is required");
    }
    if (!options.store) {
      throw new Error("DemoSubmissionStore is required");
    }
    this.service = options.service;
    this.store = options.store;
    this.nowFn = options.nowFn ?? (() => new Date().toISOString());
  }

  /**
   * Idempotent submit. Retrying the same intent never creates a duplicate
   * broker order: the first submission's broker response is returned from the
   * persisted ledger.
   */
  async submit(rawIntent: DemoOrderIntent): Promise<DemoOrderExecutionResult> {
    // 0. Validate intent schema FIRST — malformed intents must never reach
    //    the submission ledger or the broker.
    const intent = demoOrderIntentSchema.parse(rawIntent);

    // 1. Derive deterministic client order id from signal/account/intent version
    const clientOrderId = clientOrderIdFor(intent);

    // 2. Check submission ledger for an existing record
    const existing = this.store.findByClientOrderId(clientOrderId);
    if (existing && existing.status !== "pending") {
      // Already reconciled — return recorded response, no new broker order.
      const response = existing.response as Record<string, unknown>;
      return demoOrderExecutionResultSchema.parse({
        ...response,
        clientOrderId: existing.clientOrderId,
      });
    }

    // 3. Persist pending submission BEFORE sending (crash-safe retry point)
    const nowUtc = this.nowFn();
    this.store.savePending({
      clientOrderId,
      intent,
      firstSubmittedAtUtc: existing?.firstSubmittedAtUtc ?? nowUtc,
      lastAttemptAtUtc: nowUtc,
      attemptCount: existing ? existing.attemptCount + 1 : 1,
      brokerTicket: null,
      status: "pending",
      response: null,
    });

    // 4. Submit through guarded service (guard validates demo account/env)
    const result = await this.service.submitDemoOrder(clientOrderId, intent);

    // 5. Record broker response in the ledger (reconciliation)
    this.store.recordResponse(
      clientOrderId,
      result.brokerTicket,
      result.status === "filled"
        ? "filled"
        : result.status === "rejected"
          ? "rejected"
          : "acknowledged",
      result as unknown as Record<string, unknown>,
      this.nowFn(),
    );

    return result;
  }
}
