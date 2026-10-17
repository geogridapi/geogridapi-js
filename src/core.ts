// HTTP transport: auth, timeouts, retries and error mapping.

import { APIConnectionError, GeoGridAPIError, errorFromResponse, isTransient } from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.geogridapi.io";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;

export interface ClientOptions {
  /** API key (`gga_live_…` or `gga_test_…`). Defaults to `process.env.GEOGRIDAPI_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://api.geogridapi.io`. */
  baseURL?: string;
  /** Timeout of each HTTP request, in milliseconds (default 60 000). */
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx (default 2). Grid and batch creations are retried with the same idempotency key. */
  maxRetries?: number;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /** Same key = same grid or batch, never charged twice. Generated when omitted. */
  idempotencyKey?: string;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string;
  /** Safe to send again after a network error or a 5xx. */
  retryable: boolean;
  binary?: boolean;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name]?.trim() || undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}

function retryDelayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base / 2 + Math.random() * (base / 2);
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class Transport {
  // Native private field: the key never shows in console.log, util.inspect or JSON.stringify.
  readonly #apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey?.trim() || readEnv("GEOGRIDAPI_API_KEY");
    if (!apiKey) {
      throw new GeoGridAPIError(
        "Missing GeoGridAPI API key: pass { apiKey } or set GEOGRIDAPI_API_KEY. Create one at https://geogridapi.io/en/console.",
        { code: "missing_api_key" },
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new GeoGridAPIError("No fetch implementation found: use Node.js 20+ or pass { fetch }.", { code: "missing_fetch" });
    }
    this.#apiKey = apiKey;
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = fetchImpl;
  }

  /** Whether the key is a test key (free mock grids). */
  get isTestKey(): boolean {
    return this.#apiKey.startsWith("gga_test_");
  }

  private buildURL(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseURL}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  private headers(spec: RequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: spec.binary ? "image/png" : "application/json",
      "User-Agent": `geogridapi-node/${VERSION}`,
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (spec.idempotencyKey) headers["Idempotency-Key"] = spec.idempotencyKey;
    return headers;
  }

  async request<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const url = this.buildURL(spec.path, spec.query);
    const init: RequestInit = {
      method: spec.method,
      headers: this.headers(spec),
      ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw options.signal.reason;
      const outcome = await this.attempt<T>(url, init, spec, options);
      if (outcome.ok) return outcome.value;
      const { error } = outcome;
      // A 429 is refused before any processing: always safe to send again.
      const transient = error.status === 429 || (spec.retryable && isTransient(error));
      if (!transient || attempt >= maxRetries) throw error;
      await sleep(retryDelayMs(attempt, error.retryAfter), options.signal);
    }
  }

  /** One HTTP exchange. A caller abort is rethrown as is; everything else becomes a GeoGridAPIError. */
  private async attempt<T>(
    url: string,
    init: RequestInit,
    spec: RequestSpec,
    options: RequestOptions,
  ): Promise<{ ok: true; value: T } | { ok: false; error: GeoGridAPIError }> {
    const { signal, cleanup } = combineSignals(options.timeoutMs ?? this.timeoutMs, options.signal);
    try {
      const response = await this.fetchImpl(url, { ...init, signal });
      if (response.ok) {
        const value = spec.binary ? new Uint8Array(await response.arrayBuffer()) : await readBody(response);
        return { ok: true, value: value as T };
      }
      const body = await readBody(response);
      return { ok: false, error: errorFromResponse(response.status, body, parseRetryAfter(response.headers.get("retry-after"))) };
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason;
      const timedOut = signal.aborted;
      const message = timedOut ? "GeoGridAPI request timed out." : "Could not reach GeoGridAPI.";
      return { ok: false, error: new APIConnectionError(message, { code: timedOut ? "timeout" : "connection_error", cause }) };
    } finally {
      cleanup();
    }
  }
}
