/** R1.15 Twelve Data credential and bounded read-only egress boundary. */
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

export const TWELVE_DATA_ORIGIN = "https://api.twelvedata.com";
export const TWELVE_DATA_PATH = "/time_series";
export const TWELVE_DATA_SECRET_FILE = "twelve-data.json";
export const TWELVE_DATA_TIMEOUT_MS = 5_000;
export const TWELVE_DATA_MAX_ATTEMPTS = 2;
export const TWELVE_DATA_MINUTE_BUDGET = 8;
export const TWELVE_DATA_DAY_BUDGET = 800;
export const TWELVE_DATA_PAIRS = Object.freeze([
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD",
] as const);
export const TWELVE_DATA_INTERVALS = Object.freeze(["15min", "1h", "4h"] as const);

type Pair = (typeof TWELVE_DATA_PAIRS)[number];
type Interval = (typeof TWELVE_DATA_INTERVALS)[number];

export type BoundaryFailureCode =
  | "secret_missing" | "secret_symlink" | "secret_not_regular"
  | "secret_permissions" | "secret_owner" | "secret_invalid"
  | "request_denied" | "dns_denied" | "rate_budget_exhausted"
  | "timeout" | "network_error" | "provider_error";

export interface BoundaryFailure {
  readonly ok: false;
  readonly code: BoundaryFailureCode;
  readonly detail: string;
  readonly attempts: number;
}

export interface BoundarySuccess {
  readonly ok: true;
  readonly status: 200;
  readonly bodyText: string;
  readonly attempts: number;
  readonly credentialFingerprint: string;
}

export type BoundaryResult = BoundarySuccess | BoundaryFailure;

export interface AuditEvent {
  readonly event: "twelve_data_read";
  readonly outcome: "passed" | "failed";
  readonly code: "ok" | BoundaryFailureCode;
  readonly attempts: number;
  readonly path: typeof TWELVE_DATA_PATH;
  readonly queryKeys: readonly string[];
  readonly credentialFingerprint?: string;
}

export interface HttpRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: typeof TWELVE_DATA_TIMEOUT_MS;
  readonly redirect: "error";
}

export interface HttpResponse {
  readonly status: number;
  readonly bodyText: string;
}

export interface TwelveDataPorts {
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly send: (request: HttpRequest) => Promise<HttpResponse>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly nowMs: () => number;
  readonly audit: (event: AuditEvent) => void;
}

export interface TwelveDataQuery {
  readonly pair: Pair;
  readonly interval: Interval;
  readonly outputsize: number;
  /** Optional provider range, both required together; UTC bar-open instants. */
  readonly startDateUtc?: string;
  readonly endDateUtc?: string;
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export function redactBoundaryDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(?:api[_-]?key|authorization|token|secret|credential)\s*[:=]\s*[^\s,;]+/giu, "secret=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{20,}/gu, "[REDACTED]")
    .slice(0, 180);
}

export function loadTwelveDataSecret(configDir: string, expectedUid: number | null = process.getuid?.() ?? null):
  | { readonly ok: true; readonly apiKey: string; readonly fingerprint: string }
  | { readonly ok: false; readonly code: BoundaryFailureCode; readonly detail: string } {
  const file = path.join(configDir, TWELVE_DATA_SECRET_FILE);
  let link;
  try {
    link = lstatSync(file);
  } catch {
    return { ok: false, code: "secret_missing", detail: `missing ${TWELVE_DATA_SECRET_FILE}` };
  }
  if (link.isSymbolicLink()) return { ok: false, code: "secret_symlink", detail: "symlink refused" };
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { ok: false, code: "secret_invalid", detail: "secret not stat-able" };
  }
  if (!stat.isFile()) return { ok: false, code: "secret_not_regular", detail: "secret is not a regular file" };
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
    return { ok: false, code: "secret_permissions", detail: "secret must be mode 0600" };
  }
  if (expectedUid !== null && stat.uid !== expectedUid) {
    return { ok: false, code: "secret_owner", detail: "secret owner mismatch" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, code: "secret_invalid", detail: "secret JSON invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "apiKey") {
    return { ok: false, code: "secret_invalid", detail: "secret shape invalid" };
  }
  const apiKey = (parsed as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 256 || !/^[!-~]+$/u.test(apiKey)) {
    return { ok: false, code: "secret_invalid", detail: "apiKey invalid" };
  }
  return { ok: true, apiKey, fingerprint: fingerprint(apiKey) };
}

function deniedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  const candidate = mapped ?? normalized;
  if (isIP(candidate) !== 4) return isIP(address) !== 6;
  const [a, b] = candidate.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

export function assertPublicResolution(addresses: readonly string[]): void {
  if (addresses.length === 0 || addresses.some(deniedAddress)) throw new Error("dns_denied");
}

export function buildTwelveDataRequest(query: TwelveDataQuery, apiKey: string): HttpRequest {
  if (!TWELVE_DATA_PAIRS.includes(query.pair) || !TWELVE_DATA_INTERVALS.includes(query.interval) ||
      !Number.isSafeInteger(query.outputsize) || query.outputsize < 1 || query.outputsize > 5_000) {
    throw new Error("request_denied");
  }
  const hasStart = query.startDateUtc !== undefined;
  const hasEnd = query.endDateUtc !== undefined;
  if (hasStart !== hasEnd) throw new Error("request_denied");
  const utcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u;
  if (hasStart && hasEnd && (
    !utcInstant.test(query.startDateUtc as string) ||
    !utcInstant.test(query.endDateUtc as string) ||
    Date.parse(query.startDateUtc as string) > Date.parse(query.endDateUtc as string)
  )) throw new Error("request_denied");
  const url = new URL(TWELVE_DATA_PATH, TWELVE_DATA_ORIGIN);
  const parameters: Record<string, string> = {
    symbol: query.pair,
    interval: query.interval,
    outputsize: String(query.outputsize),
    format: "JSON",
    timezone: "UTC",
  };
  if (hasStart && hasEnd) {
    parameters.start_date = (query.startDateUtc as string).replace("T", " ").replace(".000Z", "");
    parameters.end_date = (query.endDateUtc as string).replace("T", " ").replace(".000Z", "");
  }
  url.search = new URLSearchParams(parameters).toString();
  const allowedKeys = hasStart
    ? "end_date,format,interval,outputsize,start_date,symbol,timezone"
    : "format,interval,outputsize,symbol,timezone";
  if (url.origin !== TWELVE_DATA_ORIGIN || url.pathname !== TWELVE_DATA_PATH ||
      [...url.searchParams.keys()].sort().join(",") !== allowedKeys) {
    throw new Error("request_denied");
  }
  return Object.freeze({
    method: "GET",
    url: url.toString(),
    headers: Object.freeze({ Authorization: `apikey ${apiKey}`, Accept: "application/json" }),
    timeoutMs: TWELVE_DATA_TIMEOUT_MS,
    redirect: "error",
  });
}

export class TwelveDataBudget {
  private minuteStart: number;
  private dayStart: number;
  private minuteUsed = 0;
  private dayUsed = 0;
  constructor(nowMs: number) { this.minuteStart = nowMs; this.dayStart = nowMs; }
  take(nowMs: number): boolean {
    if (nowMs - this.minuteStart >= 60_000) { this.minuteStart = nowMs; this.minuteUsed = 0; }
    if (nowMs - this.dayStart >= 86_400_000) { this.dayStart = nowMs; this.dayUsed = 0; }
    if (this.minuteUsed >= TWELVE_DATA_MINUTE_BUDGET || this.dayUsed >= TWELVE_DATA_DAY_BUDGET) return false;
    this.minuteUsed += 1; this.dayUsed += 1; return true;
  }
}

export async function executeTwelveDataRead(options: {
  readonly configDir: string;
  readonly query: TwelveDataQuery;
  readonly ports: TwelveDataPorts;
  readonly budget: TwelveDataBudget;
  readonly expectedUid?: number | null;
}): Promise<BoundaryResult> {
  const queryKeys = Object.freeze(options.query.startDateUtc === undefined
    ? ["format", "interval", "outputsize", "symbol", "timezone"]
    : ["end_date", "format", "interval", "outputsize", "start_date", "symbol", "timezone"]);
  const audit = (result: BoundaryResult, credentialFingerprint?: string) => options.ports.audit(Object.freeze({
    event: "twelve_data_read", outcome: result.ok ? "passed" : "failed",
    code: result.ok ? "ok" : result.code, attempts: result.attempts,
    path: TWELVE_DATA_PATH, queryKeys, ...(credentialFingerprint ? { credentialFingerprint } : {}),
  }));
  const secret = loadTwelveDataSecret(options.configDir, options.expectedUid);
  if (!secret.ok) {
    const result = { ok: false, code: secret.code, detail: secret.detail, attempts: 0 } as const;
    audit(result); return result;
  }
  let request: HttpRequest;
  try { request = buildTwelveDataRequest(options.query, secret.apiKey); }
  catch {
    const result = { ok: false, code: "request_denied", detail: "request rejected", attempts: 0 } as const;
    audit(result, secret.fingerprint); return result;
  }
  try {
    assertPublicResolution(await options.ports.resolve("api.twelvedata.com"));
  } catch {
    const result = { ok: false, code: "dns_denied", detail: "DNS resolved to a denied address", attempts: 0 } as const;
    audit(result, secret.fingerprint); return result;
  }
  for (let attempt = 1; attempt <= TWELVE_DATA_MAX_ATTEMPTS; attempt += 1) {
    if (!options.budget.take(options.ports.nowMs())) {
      const result = { ok: false, code: "rate_budget_exhausted", detail: "request budget exhausted", attempts: attempt - 1 } as const;
      audit(result, secret.fingerprint); return result;
    }
    try {
      const response = await options.ports.send(request);
      if (response.status === 200) {
        const result = { ok: true, status: 200, bodyText: response.bodyText, attempts: attempt, credentialFingerprint: secret.fingerprint } as const;
        audit(result, secret.fingerprint); return result;
      }
      if (attempt < TWELVE_DATA_MAX_ATTEMPTS && (response.status === 429 || response.status >= 500)) {
        await options.ports.sleep(250 * attempt); continue;
      }
      const result = { ok: false, code: "provider_error", detail: `provider status ${response.status}`, attempts: attempt } as const;
      audit(result, secret.fingerprint); return result;
    } catch (error) {
      const code: BoundaryFailureCode = error instanceof Error && error.message === "timeout" ? "timeout" : "network_error";
      if (attempt < TWELVE_DATA_MAX_ATTEMPTS) { await options.ports.sleep(250 * attempt); continue; }
      const result = { ok: false, code, detail: redactBoundaryDetail(error), attempts: attempt } as const;
      audit(result, secret.fingerprint); return result;
    }
  }
  throw new Error("unreachable");
}

/** Constant-time helper for tests/callers that compare credential fingerprints. */
export function sameFingerprint(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}