// API resources: places, grids, batches, history, schedules and balance.

import { sleep, type IdempotentRequestOptions, type RequestOptions, type Transport } from "./core.js";
import { GeoGridAPIError, WaitTimeoutError, isTransient } from "./errors.js";
import type {
  Balance,
  Batch,
  CreateBatchParams,
  CreateGridParams,
  CreateScheduleParams,
  Estimate,
  Grid,
  GridList,
  History,
  HistoryParams,
  ListGridsParams,
  PlaceList,
  Schedule,
  ScheduleList,
} from "./types.js";

export interface WaitOptions {
  /** First delay between two status reads, in milliseconds (grids: 3 000, batches: 5 000). It then grows up to 10 s. */
  pollIntervalMs?: number;
  /** Give up after this many milliseconds (grids: 300 000, batches: 900 000). The work keeps running server side. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunOptions = IdempotentRequestOptions & { wait?: WaitOptions };

const GRID_WAIT = { pollIntervalMs: 3_000, timeoutMs: 300_000 };
const BATCH_WAIT = { pollIntervalMs: 5_000, timeoutMs: 900_000 };
const MAX_POLL_INTERVAL_MS = 10_000;
const POLL_BACKOFF = 1.5;

const newIdempotencyKey = (): string => `gga-node-${crypto.randomUUID()}`;
const segment = (id: string): string => encodeURIComponent(id);

/** Next polling delay: grows by half up to 10 s (keeps several waits under the 60 requests/minute of a key), ±10 % jitter. */
function nextInterval(current: number): number {
  return Math.min(current * POLL_BACKOFF, Math.max(MAX_POLL_INTERVAL_MS, current));
}
const withJitter = (ms: number): number => ms * (0.9 + Math.random() * 0.2);

/**
 * Reads `id` until `isDone`. Transient errors (network, 429, 5xx) are waited out until the deadline;
 * any error thrown carries the id (`gridId` or `batchId`) so the work can be read again later.
 */
async function pollUntil<T>(
  id: { gridId: string } | { batchId: string },
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  describe: (value: T | null) => string,
  defaults: { pollIntervalMs: number; timeoutMs: number },
  options: WaitOptions,
): Promise<T> {
  let interval = options.pollIntervalMs ?? defaults.pollIntervalMs;
  const deadline = Date.now() + (options.timeoutMs ?? defaults.timeoutMs);
  let last: T | null = null;
  for (;;) {
    let delay = interval;
    try {
      last = await read();
      if (isDone(last)) return last;
    } catch (error) {
      if (!(error instanceof GeoGridAPIError)) throw error;
      if (!isTransient(error)) throw Object.assign(error, id);
      if (error.retryAfter !== null) delay = Math.max(delay, error.retryAfter * 1000);
    }
    if (Date.now() + delay > deadline) {
      throw new WaitTimeoutError(`${describe(last)} Read it again later or use a webhook_url.`, { code: "wait_timeout", ...id });
    }
    await sleep(withJitter(delay), options.signal);
    interval = nextInterval(interval);
  }
}

const gridDone = (grid: Grid): boolean => grid.status === "completed" || grid.status === "failed";

export class Places {
  constructor(private readonly transport: Transport) {}

  /** Finds a Google Business Profile by name and city, with its `place_id`. Free (a live key needs a positive balance). */
  search(params: string | { q: string; language?: string }, options?: RequestOptions): Promise<PlaceList> {
    const query = typeof params === "string" ? { q: params } : params;
    return this.transport.request({ method: "GET", path: "/v1/places/search", query, retryable: true }, options);
  }
}

export class Grids {
  constructor(private readonly transport: Transport) {}

  /**
   * Starts a grid (status `pending`); it completes in 20 seconds to 2 minutes.
   * Costs 1 credit per point, refunded if the grid fails. Use `run` to wait for the result.
   * Retries inside this call reuse one idempotency key; pass your own `idempotencyKey` to make your own retries safe too.
   */
  create(params: CreateGridParams, options: IdempotentRequestOptions = {}): Promise<Grid> {
    const { idempotencyKey = newIdempotencyKey(), ...rest } = options;
    return this.transport.request({ method: "POST", path: "/v1/grids", body: params, idempotencyKey, retryable: true }, rest);
  }

  /** Exact number of points and credits a grid would cost. Free, nothing is reserved. */
  estimate(params: CreateGridParams, options?: RequestOptions): Promise<Estimate> {
    return this.transport.request({ method: "POST", path: "/v1/grids/estimate", body: params, retryable: true }, options);
  }

  /** Status and result of a grid: ranks, summary, competitors ahead and change since the previous grid. */
  get(id: string, options?: RequestOptions): Promise<Grid> {
    return this.transport.request({ method: "GET", path: `/v1/grids/${segment(id)}`, retryable: true }, options);
  }

  /** One page of grids, newest first, without point details. */
  list(params: ListGridsParams = {}, options?: RequestOptions): Promise<GridList> {
    return this.transport.request({ method: "GET", path: "/v1/grids", query: { ...params }, retryable: true }, options);
  }

  /** Every grid, newest first, reading the pages as you iterate. */
  async *listAll(params: Omit<ListGridsParams, "before"> = {}, options?: RequestOptions): AsyncGenerator<Grid> {
    let before: string | undefined;
    for (;;) {
      const page = await this.list({ ...params, before }, options);
      yield* page.data;
      if (!page.has_more || !page.next_before) return;
      before = page.next_before;
    }
  }

  /** PNG heatmap (1200 × 1092) of a completed grid. Free. */
  image(id: string, params: { lang?: "en" | "fr" } = {}, options?: RequestOptions): Promise<Uint8Array> {
    return this.transport.request(
      { method: "GET", path: `/v1/grids/${segment(id)}/image`, query: { ...params }, retryable: true, binary: true },
      options,
    );
  }

  /** Reads the grid until it is `completed` or `failed`. */
  wait(id: string, options: WaitOptions = {}): Promise<Grid> {
    return pollUntil(
      { gridId: id },
      () => this.get(id, { signal: options.signal, maxRetries: 0 }),
      gridDone,
      (grid) => `Grid ${id} is still ${grid?.status ?? "running"}.`,
      GRID_WAIT,
      options,
    );
  }

  /** Starts a grid and waits for its result (`completed` or `failed`; a failed grid is refunded). */
  async run(params: CreateGridParams, options: RunOptions = {}): Promise<Grid> {
    const { wait = {}, ...requestOptions } = options;
    const grid = await this.create(params, requestOptions);
    return gridDone(grid) ? grid : this.wait(grid.id, { signal: requestOptions.signal, ...wait });
  }
}

export class Batches {
  constructor(private readonly transport: Transport) {}

  /**
   * Up to 50 grids with the same format: one listing with several keywords, or several listings with one keyword.
   * Each grid is charged when it starts and refunded if it fails.
   */
  create(params: CreateBatchParams, options: IdempotentRequestOptions = {}): Promise<Batch> {
    const { idempotencyKey = newIdempotencyKey(), ...rest } = options;
    return this.transport.request({ method: "POST", path: "/v1/batches", body: params, idempotencyKey, retryable: true }, rest);
  }

  /** A batch and the status of each of its grids. */
  get(id: string, options?: RequestOptions): Promise<Batch> {
    return this.transport.request({ method: "GET", path: `/v1/batches/${segment(id)}`, retryable: true }, options);
  }

  /** Reads the batch until every grid is finished. */
  wait(id: string, options: WaitOptions = {}): Promise<Batch> {
    return pollUntil(
      { batchId: id },
      () => this.get(id, { signal: options.signal, maxRetries: 0 }),
      (batch) => batch.status === "completed",
      (batch) =>
        batch
          ? `Batch ${id} is still running (${batch.counts.completed + batch.counts.failed}/${batch.items_count} grids finished).`
          : `Batch ${id} is still running.`,
      BATCH_WAIT,
      options,
    );
  }

  /** Starts a batch and waits until every grid is finished. */
  async run(params: CreateBatchParams, options: RunOptions = {}): Promise<Batch> {
    const { wait = {}, ...requestOptions } = options;
    const batch = await this.create(params, requestOptions);
    return batch.status === "completed" ? batch : this.wait(batch.id, { signal: requestOptions.signal, ...wait });
  }
}

export class HistoryResource {
  constructor(private readonly transport: Transport) {}

  /** Every completed grid of the same map, oldest first, and the change between the first and the last. Free. */
  get(params: HistoryParams, options?: RequestOptions): Promise<History> {
    return this.transport.request({ method: "GET", path: "/v1/history", query: { ...params }, retryable: true }, options);
  }
}

export class Schedules {
  constructor(private readonly transport: Transport) {}

  /** Repeats a completed grid every week or every month. Each run costs the grid's credits. */
  create(params: CreateScheduleParams, options?: RequestOptions): Promise<Schedule> {
    return this.transport.request({ method: "POST", path: "/v1/schedules", body: params, retryable: false }, options);
  }

  list(options?: RequestOptions): Promise<ScheduleList> {
    return this.transport.request({ method: "GET", path: "/v1/schedules", retryable: true }, options);
  }

  /** Pauses (`paused`) or resumes (`active`) a schedule. */
  update(id: string, params: { status: "active" | "paused" }, options?: RequestOptions): Promise<Schedule> {
    return this.transport.request({ method: "PATCH", path: `/v1/schedules/${segment(id)}`, body: params, retryable: true }, options);
  }

  /** Stops repeating a grid for good. Grids already run are kept. Not retried: a lost response would turn into a 404. */
  delete(id: string, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request({ method: "DELETE", path: `/v1/schedules/${segment(id)}`, retryable: false }, options);
  }
}

export class BalanceResource {
  constructor(private readonly transport: Transport) {}

  /** Credits left on the account (1 credit = 1 grid point). */
  get(options?: RequestOptions): Promise<Balance> {
    return this.transport.request({ method: "GET", path: "/v1/balance", retryable: true }, options);
  }
}
