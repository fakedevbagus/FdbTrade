/**
 * Shadow provider access specification (M48, ADR-0037).
 *
 * The exact upstream host, paths, query keys and response field names are the
 * OPERATOR'S declaration — this repository contains no vendor endpoint, no
 * vendor symbol and no vendor credential. A template with clearly
 * non-functional placeholders is shipped at `infra/shadow/`, and a real
 * `provider-access.json` must live in an owner-only directory outside the
 * repository.
 *
 * The schema is strict and fail-closed: unknown keys, non-HTTPS hosts, hosts
 * with a path/query/userinfo, `..` in a path, prototype-polluting field names,
 * a symbol map that does not cover EXACTLY the configured runtime instruments,
 * or a response mapping without the required canonical fields are all
 * rejected before any request is built.
 */
import {
  instrumentIdSchema,
  timeframeSchema,
  type InstrumentId,
  type Timeframe,
} from "@fdbtrade/contracts";
import { z } from "zod";

import { sha256Hex, sanitizeDetail } from "./sanitize";

/** Frozen spec version; a future change requires a new literal and an ADR. */
export const SHADOW_SPEC_VERSION = 1;

/** Header names the client must never set (hop-by-hop / HTTP-managed). */
export const FORBIDDEN_AUTH_HEADERS: readonly string[] = Object.freeze([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "cookie",
]);

/** Provider-symbol charset (bounded, printable, URL-safe). */
const providerSymbolSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._:/-]+$/, "provider symbols must be printable and URL-safe");

/** Single-line, bounded text (no header/JSON injection via newlines). */
const singleLine = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\r\n]+$/, "value must be a single line");

/** Query parameter name (lowercase snake case only). */
const queryKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/**
 * Query value template: either a fixed literal or a literal containing at
 * most one `{placeholder}`. At most one placeholder keeps substitution
 * deterministic and auditable.
 */
const queryValueSchema = z
  .string()
  .max(128)
  .regex(/^[^\r\n{}]*(?:\{[a-z]+\}[^\r\n{}]*)?$/, "at most one {placeholder} per value");

/** Absolute path on the declared host: no scheme, no query, no traversal. */
const routePathSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\/[A-Za-z0-9._~/-]*$/, "path must be absolute and URL-safe")
  .refine((path) => !path.includes(".."), "path must not contain '..'")
  .refine((path) => !path.includes("//"), "path must not contain '//'");

const POLLUTION_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const rowFieldSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,64}$/)
  .refine((segment) => !POLLUTION_SEGMENTS.has(segment), "unsafe field name");

export const shadowRouteSpecSchema = z
  .object({
    path: routePathSchema,
    query: z.record(queryKeySchema, queryValueSchema).default({}),
    response: z
      .object({
        /** Object path to the row array inside the payload (may be empty). */
        rowsPath: z.array(rowFieldSchema).max(8),
        /** Canonical field name -> provider row field name. */
        fields: z.record(z.string().regex(/^[a-z_]{1,32}$/), rowFieldSchema),
      })
      .strict(),
  })
  .strict();

export type ShadowRouteSpec = z.infer<typeof shadowRouteSpecSchema>;

export const shadowAccessSpecSchema = z
  .object({
    specVersion: z.literal(SHADOW_SPEC_VERSION),
    providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    /** Exact HTTPS origin: `https://host[:port]`, nothing else. */
    host: singleLine(1, 255),
    auth: z
      .object({
        header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        /** Optional literal scheme prefix, e.g. `Bearer ` (never a secret). */
        prefix: z
          .string()
          .max(32)
          .regex(/^[^\r\n]*$/),
      })
      .strict(),
    /** Canonical instrument -> provider symbol (exactly the runtime slice). */
    symbols: z.record(instrumentIdSchema, providerSymbolSchema),
    /** Canonical timeframe -> provider interval. */
    timeframes: z.record(timeframeSchema, providerSymbolSchema),
    historical: shadowRouteSpecSchema,
    quotes: shadowRouteSpecSchema,
  })
  .strict();

export type ShadowAccessSpecInput = z.infer<typeof shadowAccessSpecSchema>;

export interface ShadowAccessSpec {
  readonly specVersion: typeof SHADOW_SPEC_VERSION;
  readonly providerId: string;
  /** Normalized HTTPS origin (no trailing slash, no path). */
  readonly host: string;
  /** Exact allowlisted hostname (`hostname` + optional port). */
  readonly hostname: string;
  readonly auth: { readonly header: string; readonly prefix: string };
  readonly symbols: Readonly<Record<string, string>>;
  readonly timeframes: Readonly<Record<string, string>>;
  readonly historical: ShadowRouteSpec;
  readonly quotes: ShadowRouteSpec;
  /** Stable digest of the declared integration (no secret involved). */
  readonly integrationId: string;
}

/** Fields every historical route mapping must declare. */
export const SHADOW_REQUIRED_CANDLE_FIELDS: readonly string[] = Object.freeze([
  "timestamp",
  "open",
  "high",
  "low",
  "close",
]);
/** Quote route mapping must at least identify the row and both prices. */
export const SHADOW_REQUIRED_QUOTE_FIELDS: readonly string[] = Object.freeze([
  "timestamp",
  "bid",
  "ask",
  "symbol",
]);

function assertHttpsOrigin(host: string): { origin: string; hostname: string } {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new ShadowSpecError("host_invalid", "host is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new ShadowSpecError("host_not_https", "only https origins are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ShadowSpecError("host_has_credentials", "credentials must not appear in the host");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ShadowSpecError("host_has_path", "host must be a bare origin");
  }
  const port = url.port === "" ? "" : `:${url.port}`;
  return { origin: `https://${url.hostname}${port}`, hostname: `${url.hostname}${port}` };
}

function assertMapping(
  symbols: Record<string, string>,
  requiredInstruments: readonly InstrumentId[],
): void {
  const declared = Object.keys(symbols);
  const required = new Set<string>(requiredInstruments);
  const missing = [...required].filter((id) => !declared.includes(id));
  const extra = declared.filter((id) => !required.has(id));
  if (missing.length > 0) {
    throw new ShadowSpecError("symbols_incomplete", `missing instruments: ${missing.join(",")}`);
  }
  if (extra.length > 0) {
    // A superset would silently widen the runtime universe beyond the
    // configured majors; that is a fail-closed condition.
    throw new ShadowSpecError("symbols_outside_slice", `undeclared instruments: ${extra.join(",")}`);
  }
  const values = Object.values(symbols);
  if (new Set(values).size !== values.length) {
    throw new ShadowSpecError("symbols_ambiguous", "provider symbols must be unique");
  }
}

function assertFields(route: ShadowRouteSpec, required: readonly string[], label: string): void {
  const declared = Object.keys(route.response.fields);
  const missing = required.filter((field) => !declared.includes(field));
  if (missing.length > 0) {
    throw new ShadowSpecError(`${label}_fields_incomplete`, `missing: ${missing.join(",")}`);
  }
}

/**
 * Parse and freeze an operator-declared access spec. Throws `ShadowSpecError`
 * with a stable reason for every rejection (the caller turns it into an
 * explicit `unavailable` projection — never into fixture data).
 */
export function parseShadowAccessSpec(
  raw: unknown,
  options: {
    requiredInstruments: readonly InstrumentId[];
    requiredTimeframes: readonly Timeframe[];
  },
): ShadowAccessSpec {
  const parsed = shadowAccessSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "(root)";
    throw new ShadowSpecError("spec_invalid", `${path}: ${issue?.message ?? "invalid"}`);
  }
  const spec = parsed.data;
  if (FORBIDDEN_AUTH_HEADERS.includes(spec.auth.header.toLowerCase())) {
    throw new ShadowSpecError("auth_header_forbidden", spec.auth.header);
  }
  const { origin, hostname } = assertHttpsOrigin(spec.host);
  for (const timeframe of options.requiredTimeframes) {
    if (spec.timeframes[timeframe] === undefined) {
      throw new ShadowSpecError("timeframes_incomplete", `missing: ${timeframe}`);
    }
  }
  assertMapping(spec.symbols, options.requiredInstruments);
  assertFields(spec.historical, SHADOW_REQUIRED_CANDLE_FIELDS, "historical");
  assertFields(spec.quotes, SHADOW_REQUIRED_QUOTE_FIELDS, "quotes");

  const frozen = {
    specVersion: SHADOW_SPEC_VERSION as typeof SHADOW_SPEC_VERSION,
    providerId: spec.providerId,
    host: origin,
    hostname,
    auth: Object.freeze({ header: spec.auth.header, prefix: spec.auth.prefix }),
    symbols: Object.freeze({ ...spec.symbols }),
    timeframes: Object.freeze({ ...spec.timeframes }),
    historical: Object.freeze(spec.historical),
    quotes: Object.freeze(spec.quotes),
  };
  // The integration id covers the declared shape only — never a secret.
  const integrationId = sha256Hex(
    JSON.stringify({
      specVersion: frozen.specVersion,
      providerId: frozen.providerId,
      host: frozen.host,
      authHeader: frozen.auth.header,
      symbols: frozen.symbols,
      timeframes: frozen.timeframes,
      historical: frozen.historical,
      quotes: frozen.quotes,
    }),
  ).slice(0, 16);
  return Object.freeze({ ...frozen, integrationId });
}

export class ShadowSpecError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`shadow access spec rejected (${reason}): ${sanitizeDetail(detail, 160)}`);
    this.name = "ShadowSpecError";
    this.reason = sanitizeDetail(reason, 60);
  }
}
