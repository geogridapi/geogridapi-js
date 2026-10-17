import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  UnprocessableEntityError,
  VERSION,
  APIConnectionError,
  AuthenticationError,
  GeoGridAPI,
  GeoGridAPIError,
  InsufficientCreditsError,
  RateLimitError,
  WaitTimeoutError,
} from "../src/index.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error("no more replies");
    if (reply instanceof Error) throw reply;
    const body = reply.body instanceof Uint8Array ? reply.body : reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(body as BodyInit, { status: reply.status ?? 200, headers: reply.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const grid = (status: string, extra: Record<string, unknown> = {}) => ({ id: "g1", object: "grid", status, ...extra });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GeoGridAPI client", () => {
  it("reads the key from GEOGRIDAPI_API_KEY and sends it as a bearer token", async () => {
    vi.stubEnv("GEOGRIDAPI_API_KEY", "gga_test_env");
    const { fetch, calls } = fakeFetch([{ body: { object: "balance", points: 500, mode: "test" } }]);
    const client = new GeoGridAPI({ fetch });

    const balance = await client.balance.get();

    expect(balance.points).toBe(500);
    expect(client.isTestKey).toBe(true);
    expect(calls[0]?.url).toBe("https://api.geogridapi.io/v1/balance");
    expect(header(calls[0]!.init, "authorization")).toBe("Bearer gga_test_env");
  });

  it("throws a clear error when no key is configured", () => {
    vi.stubEnv("GEOGRIDAPI_API_KEY", "");
    expect(() => new GeoGridAPI({ fetch: fakeFetch([]).fetch })).toThrow(/GEOGRIDAPI_API_KEY/);
  });

  it("builds query strings without undefined values", async () => {
    const { fetch, calls } = fakeFetch([{ body: { object: "list", data: [] } }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch, baseURL: "https://example.test/" });

    await client.places.search("Joe's Pizza, New York");
    expect(calls[0]?.url).toBe("https://example.test/v1/places/search?q=Joe%27s+Pizza%2C+New+York");
  });

  it("sends an idempotency key on grid creation and reuses it when retrying", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503, body: { error: { code: "engine_unavailable", message: "retry" } }, headers: { "retry-after": "0" } },
      { status: 202, body: grid("pending") },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const created = await client.grids.create({ query: "Joe's Pizza", keyword: "pizza", size: 7 });

    expect(created.status).toBe("pending");
    expect(calls).toHaveLength(2);
    const first = header(calls[0]!.init, "idempotency-key");
    expect(first).toMatch(/^gga-node-/);
    expect(header(calls[1]!.init, "idempotency-key")).toBe(first);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: "Joe's Pizza", keyword: "pizza", size: 7 });
  });

  it("keeps a caller idempotency key", async () => {
    const { fetch, calls } = fakeFetch([{ status: 202, body: grid("pending") }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    await client.grids.create({ place_id: "ChIJ123", keyword: "pizza" }, { idempotencyKey: "order-42" });
    expect(header(calls[0]!.init, "idempotency-key")).toBe("order-42");
  });

  it("maps API errors to typed errors with code and status", async () => {
    const { fetch } = fakeFetch([
      { status: 402, body: { error: { code: "insufficient_points", message: "Not enough points on this account." } } },
      { status: 401, body: { error: { code: "invalid_key", message: "Missing or invalid API key." } } },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const insufficient = await client.grids.create({ place_id: "ChIJ123", keyword: "pizza" }).catch((e: unknown) => e);
    expect(insufficient).toBeInstanceOf(InsufficientCreditsError);
    expect(insufficient).toMatchObject({ status: 402, code: "insufficient_points", message: "Not enough points on this account." });

    const unauthorized = await client.balance.get().catch((e: unknown) => e);
    expect(unauthorized).toBeInstanceOf(AuthenticationError);
    expect(unauthorized).toBeInstanceOf(GeoGridAPIError);
  });

  it("retries 429 with Retry-After, then gives up after maxRetries", async () => {
    const limited = { status: 429, body: { error: { code: "rate_limited", message: "slow down" } }, headers: { "retry-after": "0" } };
    const { fetch, calls } = fakeFetch([limited, limited, limited]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch, maxRetries: 2 });

    const error = await client.balance.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryAfter: 0 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a schedule creation after a network error", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("fetch failed")]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const error = await client.schedules.create({ grid_id: "g1", frequency: "weekly" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).toMatchObject({ code: "connection_error", status: null });
    expect(calls).toHaveLength(1);
  });

  it("runs a grid: creates it, then polls until completed", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 202, body: grid("pending") },
      { body: grid("running") },
      { body: grid("completed", { summary: { average_rank: 3.2 } }) },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const done = await client.grids.run({ query: "Joe's Pizza", keyword: "pizza" }, { wait: { pollIntervalMs: 1 } });

    expect(done.status).toBe("completed");
    expect(done.summary?.average_rank).toBe(3.2);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.geogridapi.io/v1/grids",
      "https://api.geogridapi.io/v1/grids/g1",
      "https://api.geogridapi.io/v1/grids/g1",
    ]);
  });

  it("returns a test grid at once when it is already completed", async () => {
    const { fetch, calls } = fakeFetch([{ status: 202, body: grid("completed") }]);
    const client = new GeoGridAPI({ apiKey: "gga_test_x", fetch });

    expect((await client.grids.run({ place_id: "ChIJ123", keyword: "pizza" })).status).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("stops waiting after the timeout", async () => {
    const { fetch } = fakeFetch([{ body: grid("running") }, { body: grid("running") }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const error = await client.grids.wait("g1", { pollIntervalMs: 5, timeoutMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ code: "wait_timeout" });
  });

  it("iterates every page of grids", async () => {
    const { fetch, calls } = fakeFetch([
      { body: { object: "list", data: [grid("completed", { id: "a" })], has_more: true, next_before: "2026-10-01T00:00:00Z" } },
      { body: { object: "list", data: [grid("completed", { id: "b" })], has_more: false, next_before: null } },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const ids: string[] = [];
    for await (const item of client.grids.listAll({ keyword: "pizza" })) ids.push(item.id);

    expect(ids).toEqual(["a", "b"]);
    expect(calls[1]?.url).toBe("https://api.geogridapi.io/v1/grids?keyword=pizza&before=2026-10-01T00%3A00%3A00Z");
  });

  it("downloads the heatmap as bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { fetch, calls } = fakeFetch([{ body: png, headers: { "content-type": "image/png" } }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const bytes = await client.grids.image("g1", { lang: "fr" });
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
    expect(calls[0]?.url).toBe("https://api.geogridapi.io/v1/grids/g1/image?lang=fr");
  });

  it("waits for a batch until every grid is finished", async () => {
    const counts = { queued: 0, pending: 0, running: 1, completed: 1, failed: 0 };
    const { fetch } = fakeFetch([
      { status: 202, body: { id: "b1", object: "batch", status: "running", items_count: 2, counts } },
      { body: { id: "b1", object: "batch", status: "completed", items_count: 2, counts: { ...counts, running: 0, completed: 2 } } },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const batch = await client.batches.run(
      { size: 3, items: [{ place_id: "ChIJ1", keyword: "pizza" }, { place_id: "ChIJ1", keyword: "pizzeria" }] },
      { wait: { pollIntervalMs: 1 } },
    );
    expect(batch.status).toBe("completed");
  });

  it("rethrows a caller abort as is", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { fetch } = fakeFetch([{ body: {} }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    await expect(client.balance.get({ signal: controller.signal })).rejects.toThrow("stop");
  });

  it("never shows the API key when the client is logged or serialized", () => {
    const key = "gga_live_secret_value_123";
    const client = new GeoGridAPI({ apiKey: key, fetch: fakeFetch([]).fetch });

    expect(inspect(client, { depth: 10 })).not.toContain(key);
    expect(JSON.stringify(client)).not.toContain(key);
    expect(inspect(client.grids, { depth: 10 })).not.toContain(key);
  });

  it("maps 422 schedule_limit to UnprocessableEntityError", async () => {
    const { fetch } = fakeFetch([{ status: 422, body: { error: { code: "schedule_limit", message: "limit" } } }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });
    await expect(client.schedules.create({ grid_id: "g1", frequency: "weekly" })).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("waits out 429 and 5xx while waiting for a grid", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 202, body: grid("pending") },
      { status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "retry-after": "0" } },
      { status: 503, body: { error: { code: "engine_unavailable", message: "retry" } } },
      new TypeError("fetch failed"),
      { body: grid("completed") },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const done = await client.grids.run({ place_id: "ChIJ1", keyword: "pizza" }, { wait: { pollIntervalMs: 1 } });
    expect(done.status).toBe("completed");
    expect(calls).toHaveLength(5);
  });

  it("keeps the grid id on an error raised after the grid was created", async () => {
    const { fetch } = fakeFetch([
      { status: 202, body: grid("pending", { id: "g-123" }) },
      { status: 404, body: { error: { code: "not_found", message: "Not found." } } },
    ]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const error = await client.grids.run({ place_id: "ChIJ1", keyword: "pizza" }, { wait: { pollIntervalMs: 1 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ gridId: "g-123" });
  });

  it("keeps the grid id when waiting times out after transient errors", async () => {
    const { fetch } = fakeFetch([{ status: 503, body: { error: { code: "engine_unavailable", message: "retry" } } }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const error = await client.grids.wait("g-9", { pollIntervalMs: 5, timeoutMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ gridId: "g-9", code: "wait_timeout" });
  });

  it("stops waiting when the caller aborts during the pause", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch([{ body: grid("running") }]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });

    const waiting = client.grids.wait("g1", { pollIntervalMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 5);
    await expect(waiting).rejects.toThrow("cancelled");
  });

  it("does not retry a schedule deletion", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("fetch failed")]);
    const client = new GeoGridAPI({ apiKey: "gga_live_x", fetch });
    await expect(client.schedules.delete("s1")).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(1);
  });

  it("reports the same version as package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
