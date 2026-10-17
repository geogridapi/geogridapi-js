import { Transport, type ClientOptions } from "./core.js";
import { BalanceResource, Batches, Grids, HistoryResource, Places, Schedules } from "./resources.js";

/**
 * GeoGridAPI client.
 *
 * ```ts
 * import { GeoGridAPI } from "geogridapi";
 * const gga = new GeoGridAPI(); // reads GEOGRIDAPI_API_KEY
 * const grid = await gga.grids.run({ query: "Joe's Pizza, New York", keyword: "pizza", size: 7 });
 * console.log(grid.summary?.average_rank, grid.ranks);
 * ```
 */
export class GeoGridAPI {
  readonly places: Places;
  readonly grids: Grids;
  readonly batches: Batches;
  readonly history: HistoryResource;
  readonly schedules: Schedules;
  readonly balance: BalanceResource;
  private readonly transport: Transport;

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options);
    this.places = new Places(this.transport);
    this.grids = new Grids(this.transport);
    this.batches = new Batches(this.transport);
    this.history = new HistoryResource(this.transport);
    this.schedules = new Schedules(this.transport);
    this.balance = new BalanceResource(this.transport);
  }

  /** Whether the client uses a test key (`gga_test_`: free mock grids). */
  get isTestKey(): boolean {
    return this.transport.isTestKey;
  }
}

export default GeoGridAPI;

export { DEFAULT_BASE_URL, type ClientOptions, type IdempotentRequestOptions, type RequestOptions } from "./core.js";
export type { RunOptions, WaitOptions } from "./resources.js";
export {
  APIConnectionError,
  APIError,
  AuthenticationError,
  ConflictError,
  GeoGridAPIError,
  InsufficientCreditsError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  UnprocessableEntityError,
  WaitTimeoutError,
  type GeoGridAPIErrorOptions,
} from "./errors.js";
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  WebhookSignatureError,
  constructEvent,
  verifyWebhookSignature,
  type VerifyOptions,
} from "./webhooks.js";
export { VERSION } from "./version.js";
export type * from "./types.js";
