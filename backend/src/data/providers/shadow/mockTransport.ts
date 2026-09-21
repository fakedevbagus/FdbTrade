/**
 * Deterministic, network-free shadow transport (M48 mock shadow gate).
 *
 * This is the transport the mock shadow gate runs against: it performs NO I/O,
 * is scripted FIFO per route, and records request METADATA ONLY (route, URL,
 * path, query keys, header NAMES). Header values are never recorded — the auth
 * header carries the secret, and the mock must not become a leak vector.
 *
 * When a route's script is exhausted the mock throws an explicit
 * `network_error:mock_queue_empty` instead of inventing a response, so an
 * unscripted call can never look like a successful provider fetch.
 */
import type { JobClock } from "@/data/ingestion/jobs";

import type { ShadowRequestPlan, ShadowRoute } from "./allowlist";
import {
  ShadowTransportError,
  type ShadowHttpResponse,
  type ShadowTransport,
  type ShadowTransportFailureCode,
} from "./transport";

export interface MockShadowRequest {
  readonly route: ShadowRoute;
  readonly method: string;
  readonly url: string;
  readonly urlHost: string;
  readonly path: string;
  readonly queryKeys: readonly string[];
  /** Header NAMES only; values (which may hold the secret) are never stored. */
  readonly headerNames: readonly string[];
  readonly timeoutMs: number;
}

export interface MockShadowSuccess {
  readonly kind: "response";
  readonly status: number;
  readonly bodyText: string;
  readonly contentType?: string;
  /** Optional simulated elapsed time (advances the injected mock clock). */
  readonly advanceMs?: number;
}

export interface MockShadowFailure {
  readonly kind: "failure";
  readonly code: ShadowTransportFailureCode;
}

export type MockShadowScript = MockShadowSuccess | MockShadowFailure;

export interface MockShadowTransport extends ShadowTransport {
  readonly requests: readonly MockShadowRequest[];
  /** Queue one scripted response for a route (FIFO). */
  queue(route: ShadowRoute, script: MockShadowScript): void;
  /** Queue a JSON response body. */
  queueJson(route: ShadowRoute, body: unknown, status?: number): void;
  /** Queue an explicit transport failure. */
  queueFailure(route: ShadowRoute, code: ShadowTransportFailureCode): void;
  /** Repeat the given script `count` times (bounded, for stream tests). */
  queueRepeat(route: ShadowRoute, script: MockShadowScript, count: number): void;
  reset(): void;
}

/** Mutable mock clock: deterministic time travel for staleness/reconnect tests. */
export interface MockClock extends JobClock {
  advanceMs(ms: number): void;
}

export function createMockClock(startUtcMs: number): MockClock {
  let now = startUtcMs;
  return {
    nowUtcMs: () => now,
    advanceMs: (ms: number) => {
      now += Math.max(0, Math.floor(ms));
    },
  };
}

export function createMockShadowTransport(options: { clock?: MockClock } = {}): MockShadowTransport {
  const queues: Record<ShadowRoute, MockShadowScript[]> = { historical: [], quotes: [] };
  const requests: MockShadowRequest[] = [];
  const clock = options.clock;

  return {
    get requests() {
      return requests;
    },
    queue(route, script) {
      queues[route].push(script);
    },
    queueJson(route, body, status = 200) {
      queues[route].push({ kind: "response", status, bodyText: JSON.stringify(body) });
    },
    queueFailure(route, code) {
      queues[route].push({ kind: "failure", code });
    },
    queueRepeat(route, script, count) {
      const bounded = Math.max(0, Math.min(1_000, Math.floor(count)));
      for (let index = 0; index < bounded; index += 1) {
        queues[route].push(script);
      }
    },
    reset() {
      queues.historical.length = 0;
      queues.quotes.length = 0;
      requests.length = 0;
    },
    async get(plan: ShadowRequestPlan, request): Promise<ShadowHttpResponse> {
      requests.push(
        Object.freeze({
          route: plan.route,
          method: plan.method,
          url: plan.url,
          urlHost: plan.urlHost,
          path: plan.path,
          queryKeys: plan.queryKeys,
          headerNames: Object.freeze(Object.keys(request.headers).sort()),
          timeoutMs: request.timeoutMs,
        }),
      );
      const script = queues[plan.route].shift();
      if (script === undefined) {
        throw new ShadowTransportError("network_error", "mock_queue_empty");
      }
      if (script.kind === "failure") {
        throw new ShadowTransportError(script.code, `scripted_${script.code}`);
      }
      if (clock && script.advanceMs !== undefined) {
        clock.advanceMs(script.advanceMs);
      }
      return {
        status: script.status,
        bodyText: script.bodyText,
        contentType: script.contentType ?? "application/json",
      };
    },
  };
}
