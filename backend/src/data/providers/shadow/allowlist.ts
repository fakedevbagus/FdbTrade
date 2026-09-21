/**
 * Shadow request allowlist (M48, ADR-0037).
 *
 * Every outbound shadow request is built HERE and nowhere else. The rules are
 * structural, not advisory:
 *
 * - the only permitted method is `GET` (there is no code path that can issue a
 *   write verb, and `SHADOW_ALLOWED_METHODS` is asserted by tests),
 * - the host is the operator-declared origin, compared exactly (scheme, host,
 *   optional port) — a redirect is refused by the transport,
 * - the path is the operator-declared path, compared exactly after URL parsing,
 * - query keys are the operator-declared keys only, and parameters that the
 *   declaration does not use are rejected instead of appended.
 *
 * A denial is a typed `ShadowRequestDeniedError` with a stable code; the
 * provider turns it into an explicit failure, never into substituted data.
 */
import type { ShadowAccessSpec, ShadowRouteSpec } from "./spec";
import { sanitizeDetail } from "./sanitize";

/** The complete set of methods the shadow path can issue. */
export const SHADOW_ALLOWED_METHODS: readonly string[] = Object.freeze(["GET"]);

export type ShadowRoute = "historical" | "quotes";

export type ShadowDeniedCode =
  | "METHOD_NOT_ALLOWED"
  | "HOST_NOT_ALLOWED"
  | "PATH_NOT_ALLOWED"
  | "QUERY_NOT_ALLOWED"
  | "PARAMETER_MISSING"
  | "PARAMETER_INVALID"
  | "URL_INVALID";

export class ShadowRequestDeniedError extends Error {
  readonly code: ShadowDeniedCode;
  readonly detail: string;

  constructor(code: ShadowDeniedCode, detail: string) {
    super(`shadow request denied (${code}): ${sanitizeDetail(detail, 160)}`);
    this.name = "ShadowRequestDeniedError";
    this.code = code;
    this.detail = sanitizeDetail(detail, 160);
  }
}

export interface ShadowRequestPlan {
  readonly route: ShadowRoute;
  readonly method: "GET";
  readonly url: string;
  readonly urlHost: string;
  readonly path: string;
  readonly queryKeys: readonly string[];
  /** Auth header NAME only; the value is added by the provider in memory. */
  readonly authHeader: string;
}

/** Printable ASCII parameter values only (no control characters, no spaces). */
const PARAMETER_VALUE_PATTERN = /^[!-~]+$/;

/** Extract the single `{placeholder}` name of a query template, if any. */
export function placeholderOf(template: string): string | null {
  const match = /\{([a-z]+)\}/.exec(template);
  return match ? match[1] : null;
}

function routeSpecFor(spec: ShadowAccessSpec, route: ShadowRoute): ShadowRouteSpec {
  return route === "historical" ? spec.historical : spec.quotes;
}


/**
 * Build an allowlisted request plan. Throws `ShadowRequestDeniedError` for any
 * undeclared parameter, non-printable value, host/path mismatch or invalid URL.
 */
export function buildShadowRequest(
  spec: ShadowAccessSpec,
  route: ShadowRoute,
  params: Readonly<Record<string, string | number>> = {},
): ShadowRequestPlan {
  const routeSpec = routeSpecFor(spec, route);
  const placeholders = new Set<string>();
  const search = new URLSearchParams();

  for (const [key, template] of Object.entries(routeSpec.query)) {
    const placeholder = placeholderOf(template);
    if (placeholder === null) {
      search.set(key, template);
      continue;
    }
    placeholders.add(placeholder);
    const raw = params[placeholder];
    if (raw === undefined) {
      throw new ShadowRequestDeniedError(
        "PARAMETER_MISSING",
        `query value for '${key}' requires {${placeholder}}`,
      );
    }
    const value = String(raw);
    if (!PARAMETER_VALUE_PATTERN.test(value)) {
      throw new ShadowRequestDeniedError("PARAMETER_INVALID", `parameter ${placeholder}`);
    }
    search.set(key, value);
  }
  for (const name of Object.keys(params)) {
    if (!placeholders.has(name)) {
      // Undeclared extras would widen the outbound request beyond the
      // operator's declaration; fail closed instead of appending them.
      throw new ShadowRequestDeniedError("QUERY_NOT_ALLOWED", `undeclared parameter ${name}`);
    }
  }

  let base: URL;
  let url: URL;
  try {
    base = new URL(spec.host);
    url = new URL(routeSpec.path, base);
  } catch {
    throw new ShadowRequestDeniedError("URL_INVALID", "declared host/path did not parse");
  }
  url.search = search.toString();

  if (url.protocol !== "https:") {
    throw new ShadowRequestDeniedError("HOST_NOT_ALLOWED", "scheme must be https");
  }
  if (url.host !== base.host) {
    throw new ShadowRequestDeniedError("HOST_NOT_ALLOWED", "host must equal the declared origin");
  }
  if (url.pathname !== routeSpec.path) {
    throw new ShadowRequestDeniedError("PATH_NOT_ALLOWED", "path must equal the declared path");
  }
  for (const key of url.searchParams.keys()) {
    if (!Object.prototype.hasOwnProperty.call(routeSpec.query, key)) {
      throw new ShadowRequestDeniedError("QUERY_NOT_ALLOWED", `undeclared query key ${key}`);
    }
  }

  return Object.freeze({
    route,
    method: "GET" as const,
    url: url.toString(),
    urlHost: url.host,
    path: url.pathname,
    queryKeys: Object.freeze([...url.searchParams.keys()]),
    authHeader: spec.auth.header,
  });
}

/**
 * Re-validate a plan against the declared spec (defence in depth for any
 * transport implementation, including injected test transports).
 */
export function assertShadowRequestAllowed(
  spec: ShadowAccessSpec,
  plan: ShadowRequestPlan,
): void {
  if (!SHADOW_ALLOWED_METHODS.includes(plan.method)) {
    throw new ShadowRequestDeniedError("METHOD_NOT_ALLOWED", plan.method);
  }
  const routeSpec = routeSpecFor(spec, plan.route);
  let url: URL;
  try {
    url = new URL(plan.url);
  } catch {
    throw new ShadowRequestDeniedError("URL_INVALID", "plan URL did not parse");
  }
  if (url.protocol !== "https:" || url.host !== spec.hostname) {
    throw new ShadowRequestDeniedError("HOST_NOT_ALLOWED", url.host);
  }
  if (url.pathname !== routeSpec.path) {
    throw new ShadowRequestDeniedError("PATH_NOT_ALLOWED", url.pathname);
  }
  for (const key of url.searchParams.keys()) {
    if (!Object.prototype.hasOwnProperty.call(routeSpec.query, key)) {
      throw new ShadowRequestDeniedError("QUERY_NOT_ALLOWED", key);
    }
  }
}
