/**
 * Structured API error taxonomy (P01-02).
 *
 * Every error a client can observe has a stable machine code, an HTTP status,
 * and a human-safe message. Unknown internal failures are deliberately
 * collapsed to a generic message by `withApi` — raw error text must never
 * reach a response because it may contain secrets or internals.
 */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INVALID_JSON",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "REPLAY_DETECTED",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,
  REPLAY_DETECTED: 409,
};


export interface ApiErrorDetails {
  /** Machine-readable details (e.g. zod issue list, allowed methods). */
  details?: unknown;
  /** Extra response headers (e.g. `allow` for 405). Never contains secrets. */
  headers?: Record<string, string>;
  /** Optional status override (defaults to the code's documented status). */
  status?: number;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
    this.headers = options.headers;
  }

  static validation(
    message = "Request body failed schema validation.",
    details?: unknown,
  ): ApiError {
    return new ApiError("VALIDATION_ERROR", message, { details });
  }

  static invalidJson(
    message = "Request body is not valid JSON.",
  ): ApiError {
    return new ApiError("INVALID_JSON", message);
  }

  static unsupportedMediaType(
    message = "Content-Type must be application/json.",
  ): ApiError {
    return new ApiError("UNSUPPORTED_MEDIA_TYPE", message);
  }

  static payloadTooLarge(
    message = "Request body exceeds the maximum accepted size.",
  ): ApiError {
    return new ApiError("PAYLOAD_TOO_LARGE", message);
  }

  static notFound(message = "Resource not found."): ApiError {
    return new ApiError("NOT_FOUND", message);
  }

  static unauthorized(
    message = "Authentication is required to access this resource.",
  ): ApiError {
    return new ApiError("UNAUTHORIZED", message);
  }

  static forbidden(
    message = "You are not authorized to perform this action.",
  ): ApiError {
    return new ApiError("FORBIDDEN", message);
  }

  static methodNotAllowed(
    allowed: readonly string[],
    message = "HTTP method not allowed for this resource.",
  ): ApiError {
    return new ApiError("METHOD_NOT_ALLOWED", message, {
      details: { allowed: [...allowed] },
      headers: { allow: allowed.join(", ") },
    });
  }

  static internal(
    message = "Internal server error.",
  ): ApiError {
    return new ApiError("INTERNAL_ERROR", message);
  }

  static rateLimited(
    message = "Too many requests. Please try again later.",
  ): ApiError {
    return new ApiError("RATE_LIMITED", message, { status: 429 });
  }

  static replayDetected(
    message = "Duplicate request detected. Please retry with a new request ID.",
  ): ApiError {
    return new ApiError("REPLAY_DETECTED", message, { status: 409 });
  }
}
