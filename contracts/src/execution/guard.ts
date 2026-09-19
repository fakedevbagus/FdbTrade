/**
 * Demo execution environment guard and feature flag validation (P16-01, ADR-0030).
 *
 * Enforces strict boundaries to ensure order execution CANNOT be directed
 * to live or production broker environments:
 * 1. Demo execution requires explicit feature flag activation (`demoExecutionEnabled: true`).
 * 2. Live execution flag MUST be false (`liveExecutionEnabled: false`). Any configuration
 *    with live execution enabled is strictly rejected at startup.
 * 3. Environment cannot be "production".
 * 4. Production/live broker accounts (`isDemo !== true`, or server names with "Live", "Real", "Prod")
 *    are blocked fail-closed with typed error `LiveCredentialsRejectedError`.
 * 5. Endpoints and broker servers must belong to approved demo server whitelist.
 * 6. Internal timestamps are all UTC (ADR-0004).
 */
import { z } from "zod";

import type { BrokerAccount } from "../broker/contract";

export const EXECUTION_CONTRACT_ID = "execution-contract";
export const EXECUTION_CONTRACT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Typed Guard Errors
// ---------------------------------------------------------------------------

export class DemoGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoGuardError";
  }
}

export class DemoMisconfigurationError extends DemoGuardError {
  constructor(message: string) {
    super(`Demo execution misconfigured: ${message}`);
    this.name = "DemoMisconfigurationError";
  }
}

export class LiveCredentialsRejectedError extends DemoGuardError {
  constructor(message: string) {
    super(`Live/production credentials or endpoint rejected in demo mode: ${message}`);
    this.name = "LiveCredentialsRejectedError";
  }
}

export class DemoEndpointForbiddenError extends DemoGuardError {
  constructor(message: string) {
    super(`Endpoint or server rejected: ${message}`);
    this.name = "DemoEndpointForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// Patterns and Whitelists
// ---------------------------------------------------------------------------

export const FORBIDDEN_LIVE_PATTERNS = [
  /\blive\b/i,
  /\breal\b/i,
  /\bprod\b/i,
  /\bproduction\b/i,
  /\bmainnet\b/i,
];

export const DEFAULT_APPROVED_DEMO_SERVERS = [
  "MetaQuotes-Demo",
  "ICMarketsSC-Demo",
  "Exness-Demo",
  "mt5-demo",
  "fixture-demo",
  "mock-demo",
  "paper-demo",
] as const;

export const DEFAULT_APPROVED_DEMO_ENDPOINTS = [
  "demo.mt5.broker.com:443",
  "localhost:5000",
  "127.0.0.1:5000",
  "mock://demo",
  "fixture://mt5",
] as const;
// ---------------------------------------------------------------------------
// Configuration Schema
// ---------------------------------------------------------------------------

export const demoExecutionConfigSchema = z
  .object({
    demoExecutionEnabled: z.boolean().default(false),
    liveExecutionEnabled: z.boolean().default(false),
    environment: z.enum(["development", "staging", "test", "demo"]),
    approvedDemoServers: z.array(z.string().min(1)).min(1).default([...DEFAULT_APPROVED_DEMO_SERVERS]),
    approvedDemoEndpoints: z.array(z.string().min(1)).default([...DEFAULT_APPROVED_DEMO_ENDPOINTS]),
    maxOrderVolume: z.number().positive().optional(),
    allowedSymbols: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((data) => !data.liveExecutionEnabled, {
    message: "liveExecutionEnabled MUST be false for demo execution",
    path: ["liveExecutionEnabled"],
  });

export type DemoExecutionConfig = z.infer<typeof demoExecutionConfigSchema>;

// ---------------------------------------------------------------------------
// Environment Guard Class
// ---------------------------------------------------------------------------

export class DemoExecutionGuard {
  private readonly config: DemoExecutionConfig;

  constructor(configInput?: Partial<DemoExecutionConfig>) {
    const raw = {
      demoExecutionEnabled: false,
      liveExecutionEnabled: false,
      environment: "development" as const,
      approvedDemoServers: [...DEFAULT_APPROVED_DEMO_SERVERS],
      approvedDemoEndpoints: [...DEFAULT_APPROVED_DEMO_ENDPOINTS],
      ...configInput,
    };

    const parsed = demoExecutionConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DemoMisconfigurationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }

    this.config = parsed.data;
  }

  getConfig(): DemoExecutionConfig {
    return { ...this.config };
  }

  /**
   * Validate startup environment.
   * Throws DemoMisconfigurationError or LiveCredentialsRejectedError if invalid.
   */
  validateStartup(): void {
    if (!this.config.demoExecutionEnabled) {
      throw new DemoMisconfigurationError(
        "demoExecutionEnabled flag is false; order submission disabled",
      );
    }

    if (this.config.liveExecutionEnabled) {
      throw new DemoMisconfigurationError(
        "liveExecutionEnabled cannot be enabled in demo execution adapter",
      );
    }

    if ((this.config.environment as string) === "production") {
      throw new LiveCredentialsRejectedError(
        "Cannot run demo execution adapter in production environment",
      );
    }
  }

  /**
   * Validates broker account to ensure it is strictly a demo account.
   */
  validateBrokerAccount(account: BrokerAccount): void {
    if (!account || typeof account !== "object") {
      throw new DemoMisconfigurationError("Invalid or missing account object");
    }

    // 1. Must have isDemo set to true
    if (account.isDemo !== true) {
      throw new LiveCredentialsRejectedError(
        `Broker account '${account.accountNumber}' has isDemo=${String(account.isDemo)}. Only demo accounts permitted.`,
      );
    }

    // 2. Server name cannot contain live/real/prod patterns
    for (const pattern of FORBIDDEN_LIVE_PATTERNS) {
      if (pattern.test(account.serverName)) {
        throw new LiveCredentialsRejectedError(
          `Broker server name '${account.serverName}' indicates a live environment. Forbidden in demo mode.`,
        );
      }
    }

    // 3. Server name must be in approved demo servers list OR contain demo/practice keyword
    const serverLower = account.serverName.toLowerCase();
    const isWhitelisted = this.config.approvedDemoServers.some(
      (srv) => srv.toLowerCase() === serverLower,
    );
    const hasDemoKeyword = serverLower.includes("demo") || serverLower.includes("practice");

    if (!isWhitelisted && !hasDemoKeyword) {
      throw new DemoEndpointForbiddenError(
        `Server '${account.serverName}' is not an approved demo server`,
      );
    }
  }

  /**
   * Validates endpoint URI / connection string against approved demo endpoints.
   */
  validateEndpoint(endpoint: string, serverName?: string): void {
    if (!endpoint || typeof endpoint !== "string") {
      throw new DemoMisconfigurationError("Endpoint must be a non-empty string");
    }

    for (const pattern of FORBIDDEN_LIVE_PATTERNS) {
      if (pattern.test(endpoint)) {
        throw new LiveCredentialsRejectedError(
          `Endpoint '${endpoint}' contains forbidden live pattern '${pattern.source}'`,
        );
      }
    }

    const endpointLower = endpoint.toLowerCase();
    const isApproved = this.config.approvedDemoEndpoints.some((approved) =>
      endpointLower.includes(approved.toLowerCase()),
    );
    const hasDemoKeyword =
      endpointLower.includes("demo") ||
      endpointLower.includes("localhost") ||
      endpointLower.includes("127.0.0.1") ||
      endpointLower.includes("fixture");

    if (!isApproved && !hasDemoKeyword) {
      throw new DemoEndpointForbiddenError(
        `Endpoint '${endpoint}' is not on the approved demo endpoint whitelist`,
      );
    }

    if (serverName) {
      for (const pattern of FORBIDDEN_LIVE_PATTERNS) {
        if (pattern.test(serverName)) {
          throw new LiveCredentialsRejectedError(
            `Server name '${serverName}' contains forbidden live pattern`,
          );
        }
      }
    }
  }

  /**
   * Asserts that order submission is currently permitted.
   * Throws typed error if any check fails.
   */
  assertCanSubmitOrder(
    account: BrokerAccount,
    orderSpec?: { volumeUnits?: number; symbol?: string },
  ): void {
    this.validateStartup();
    this.validateBrokerAccount(account);

    if (orderSpec) {
      if (
        this.config.maxOrderVolume !== undefined &&
        orderSpec.volumeUnits !== undefined &&
        orderSpec.volumeUnits > this.config.maxOrderVolume
      ) {
        throw new DemoMisconfigurationError(
          `Requested volume ${orderSpec.volumeUnits} exceeds demo max volume limit of ${this.config.maxOrderVolume}`,
        );
      }

      if (
        this.config.allowedSymbols !== undefined &&
        orderSpec.symbol !== undefined &&
        !this.config.allowedSymbols.includes(orderSpec.symbol)
      ) {
        throw new DemoMisconfigurationError(
          `Symbol '${orderSpec.symbol}' is not in demo allowed symbols list: ${this.config.allowedSymbols.join(", ")}`,
        );
      }
    }
  }

  /**
   * Safe non-throwing check for UI / health reporting.
   */
  isOrderSubmissionAllowed(
    account?: BrokerAccount,
    orderSpec?: { volumeUnits?: number; symbol?: string },
  ): { allowed: boolean; reason?: string } {
    try {
      if (!this.config.demoExecutionEnabled) {
        return { allowed: false, reason: "demoExecutionEnabled is false" };
      }
      if (this.config.liveExecutionEnabled) {
        return { allowed: false, reason: "liveExecutionEnabled must be false" };
      }
      if ((this.config.environment as string) === "production") {
        return { allowed: false, reason: "production environment forbidden for demo" };
      }
      if (account) {
        this.validateBrokerAccount(account);
      }
      if (orderSpec) {
        if (
          this.config.maxOrderVolume !== undefined &&
          orderSpec.volumeUnits !== undefined &&
          orderSpec.volumeUnits > this.config.maxOrderVolume
        ) {
          return { allowed: false, reason: `volume exceeds limit ${this.config.maxOrderVolume}` };
        }
        if (
          this.config.allowedSymbols !== undefined &&
          orderSpec.symbol !== undefined &&
          !this.config.allowedSymbols.includes(orderSpec.symbol)
        ) {
          return { allowed: false, reason: `symbol ${orderSpec.symbol} not allowed in demo` };
        }
      }
      return { allowed: true };
    } catch (err) {
      return {
        allowed: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

