// Errors thrown by the client. Every API error carries the `code` and
// `message` of the `{ error: { code, message } }` envelope.

export interface GeoGridAPIErrorOptions {
  status?: number | null;
  code?: string;
  retryAfter?: number | null;
  body?: unknown;
  cause?: unknown;
  gridId?: string;
  batchId?: string;
}

export class GeoGridAPIError extends Error {
  /** HTTP status, `null` when no response was received. */
  readonly status: number | null;
  /** API error code (`invalid_body`, `insufficient_points`, `rate_limited`…). */
  readonly code: string;
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfter: number | null;
  /** Parsed error body, when there is one. */
  readonly body: unknown;
  /** Set when the error happened after a grid was created (while waiting for it): read it later with `grids.get`. */
  gridId?: string;
  /** Set when the error happened after a batch was created (while waiting for it): read it later with `batches.get`. */
  batchId?: string;

  constructor(message: string, options: GeoGridAPIErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? null;
    this.code = options.code ?? "unknown_error";
    this.retryAfter = options.retryAfter ?? null;
    this.body = options.body;
    if (options.gridId) this.gridId = options.gridId;
    if (options.batchId) this.batchId = options.batchId;
  }
}

/** 400: invalid body or parameters. */
export class InvalidRequestError extends GeoGridAPIError {}
/** 401: missing, malformed, unknown or revoked API key. */
export class AuthenticationError extends GeoGridAPIError {}
/** 402: not enough credits for this grid or batch. */
export class InsufficientCreditsError extends GeoGridAPIError {}
/** 404: unknown grid, batch or schedule, or no listing matches. */
export class NotFoundError extends GeoGridAPIError {}
/** 409: conflicting state (grid not ready, already scheduled, idempotency key reused…). */
export class ConflictError extends GeoGridAPIError {}
/** 422: an account limit is reached (`schedule_limit`). */
export class UnprocessableEntityError extends GeoGridAPIError {}
/** 429: too many requests or too many grids still running. */
export class RateLimitError extends GeoGridAPIError {}
/** 5xx: the API or the ranking engine is temporarily unavailable. */
export class APIError extends GeoGridAPIError {}
/** No response: network failure or request timeout. */
export class APIConnectionError extends GeoGridAPIError {}
/** A grid or batch did not finish within the wait timeout. It keeps running server side. */
export class WaitTimeoutError extends GeoGridAPIError {}

export function errorFromResponse(status: number, body: unknown, retryAfter: number | null): GeoGridAPIError {
  const envelope = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : `http_${status}`;
  const message = typeof envelope?.message === "string" ? envelope.message : `GeoGridAPI request failed with status ${status}`;
  const options = { status, code, retryAfter, body };
  if (status === 400) return new InvalidRequestError(message, options);
  if (status === 401) return new AuthenticationError(message, options);
  if (status === 402) return new InsufficientCreditsError(message, options);
  if (status === 404) return new NotFoundError(message, options);
  if (status === 409) return new ConflictError(message, options);
  if (status === 422) return new UnprocessableEntityError(message, options);
  if (status === 429) return new RateLimitError(message, options);
  if (status >= 500) return new APIError(message, options);
  return new GeoGridAPIError(message, options);
}

/** Errors worth waiting out: no response, timeout, 429 or 5xx. */
export function isTransient(error: GeoGridAPIError): boolean {
  return error.status === null || error.status === 408 || error.status === 429 || error.status >= 500;
}
