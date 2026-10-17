# GeoGridAPI Node.js SDK

[![npm](https://img.shields.io/npm/v/geogridapi.svg)](https://www.npmjs.com/package/geogridapi)
[![license](https://img.shields.io/npm/l/geogridapi.svg)](LICENSE)

The official Node.js and TypeScript client for [GeoGridAPI](https://geogridapi.io), the geo-grid rank tracking API for Google Maps (local SEO).

Send a Google Business Profile and a keyword: GeoGridAPI measures the listing's rank in the Google Maps results at every point of a grid around it, and returns the rank matrix, the competitors ranking ahead, the change since the previous grid and a PNG heatmap. 1 credit = 1 grid point.

- Fully typed, zero dependencies, ESM and CommonJS
- Node.js 20+, Bun, Deno, Cloudflare Workers and edge runtimes (uses `fetch` and Web Crypto)
- Automatic retries with an idempotency key: a retried request never creates or charges a second grid
- `grids.run()` starts a grid and waits for the result
- Webhook signature verification

## Install

```bash
npm install geogridapi
```

## Quickstart

Create an account on [geogridapi.io](https://geogridapi.io) (500 free credits), then an API key in the console. A `gga_live_` key measures real grids and spends credits. A `gga_test_` key returns free sample grids, handy while you build.

```ts
import { GeoGridAPI } from "geogridapi";

const gga = new GeoGridAPI(); // reads process.env.GEOGRIDAPI_API_KEY

const grid = await gga.grids.run({
  query: "Joe's Pizza, New York", // or place_id: "ChIJ…"
  keyword: "pizza",
  size: 7, // 7 × 7 = 49 credits
  radius_km: 3,
});

console.log(grid.summary);
// { average_rank: 4.3, average_rank_with_misses: 4.6, top3_points: 28, found_points: 48 }
console.log(grid.ranks); // 7 × 7 matrix, row 0 = north, null = not in the top 20
console.log(grid.competitors); // who ranks ahead
```

A grid takes 20 seconds to 2 minutes. `grids.run()` polls until it is `completed` or `failed` (a failed grid is refunded). To start it without waiting, use `grids.create()` then `grids.get()`, or pass a `webhook_url`.

## Usage

```ts
// Find a listing and its place_id (free)
const { data: places } = await gga.places.search("Joe's Pizza, New York");

// Exact cost before running (free)
const estimate = await gga.grids.estimate({ place_id: places[0].place_id, keyword: "pizza", shape: "circle", density: "medium" });
console.log(estimate.credits, estimate.balance_after);

// Start a grid without waiting
const pending = await gga.grids.create({ place_id: "ChIJ…", keyword: "pizza", webhook_url: "https://example.com/hooks/geogrid" });
const grid = await gga.grids.wait(pending.id);

// PNG heatmap of a completed grid (free)
import { writeFile } from "node:fs/promises";
await writeFile("map.png", await gga.grids.image(grid.id, { lang: "en" }));

// Ranking trend of the same map over time (free)
const history = await gga.history.get({ place_id: "ChIJ…", keyword: "pizza" });
console.log(history.change?.average_rank); // negative = better

// Up to 50 grids in one call: one listing × several keywords, or several listings × one keyword
const batch = await gga.batches.run({
  size: 5,
  items: [
    { place_id: "ChIJ…", keyword: "pizza" },
    { place_id: "ChIJ…", keyword: "pizza delivery" },
  ],
});

// Repeat a grid every week or every month
const schedule = await gga.schedules.create({ grid_id: grid.id, frequency: "weekly", weekday: 1 });
await gga.schedules.update(schedule.id, { status: "paused" });

// Every grid, page after page
for await (const g of gga.grids.listAll({ keyword: "pizza" })) console.log(g.id, g.summary?.average_rank);

// Credits left
const { points } = await gga.balance.get();
```

### Grid formats

| Parameter | Values |
|---|---|
| `shape` | `square` (default), `circle`, `diamond`, `hexagon`, `cross`, `ellipse`, `rectangle` |
| `size` | Square only: `3`, `5`, `7` (default) or `9` → 9, 25, 49 or 81 credits |
| `density` | Other shapes: `low`, `medium` (default) or `high`, 13 to 49 points |
| `radius_km` | 0.5 to 30 km from center to edge (other shapes: from 1 km) |
| `language`, `country` | 2-letter codes |

Points that fall at sea are neither measured nor charged.

## Errors

Every API error is a `GeoGridAPIError` with `status`, `code` and `message`, and a subclass per status:

```ts
import { InsufficientCreditsError, NotFoundError, RateLimitError } from "geogridapi";

try {
  await gga.grids.run({ query: "Unknown place", keyword: "pizza" });
} catch (error) {
  if (error instanceof InsufficientCreditsError) console.log("Top up at https://geogridapi.io");
  else if (error instanceof NotFoundError) console.log(error.code); // place_not_found
  else throw error;
}
```

| Class | Status |
|---|---|
| `InvalidRequestError` | 400 |
| `AuthenticationError` | 401 |
| `InsufficientCreditsError` | 402 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 (`grid_not_ready`, `already_scheduled`…) |
| `UnprocessableEntityError` | 422 (`schedule_limit`) |
| `RateLimitError` | 429 |
| `APIError` | 5xx |
| `APIConnectionError` | network error or timeout |
| `WaitTimeoutError` | `run()`/`wait()` gave up; the grid keeps running |

Network errors, 429 and 5xx are retried twice with backoff (`Retry-After` is honored). Grid and batch creations send an `Idempotency-Key`, so these retries never create or charge a second grid. The key is new for each call: when your own code retries a creation (a queue job, a cron), pass your own `idempotencyKey`, for example an order or job id:

```ts
await gga.grids.run({ place_id: "ChIJ…", keyword: "pizza" }, { idempotencyKey: `weekly-report-${jobId}` });
```

While `run()` or `wait()` waits, network errors, 429 and 5xx are waited out until the timeout. If waiting still fails, the error carries `gridId` (or `batchId`): the grid exists, read it later with `grids.get()` instead of running it again. A failed grid has `status: "failed"` and `error: { code, message }`.

Set `maxRetries` and `timeoutMs` on the client or per call.

## Webhooks

When a grid ends, GeoGridAPI posts a `grid.completed` or `grid.failed` event to its `webhook_url`, signed with your `whsec_` secret (console → Webhook). Verify it against the raw body:

```ts
import { constructEvent } from "geogridapi";

// Express: app.post("/hooks/geogrid", express.raw({ type: "application/json" }), handler)
async function handler(req, res) {
  try {
    const event = await constructEvent(req.body, req.get("GeoGridAPI-Signature"), process.env.GEOGRIDAPI_WEBHOOK_SECRET);
    if (event.type === "grid.completed") console.log(event.data.summary);
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
}
```

`verifyWebhookSignature()` returns a boolean instead. Signatures older than 5 minutes are refused (`toleranceSeconds`).

## Configuration

```ts
const gga = new GeoGridAPI({
  apiKey: "gga_live_…", // default: process.env.GEOGRIDAPI_API_KEY
  timeoutMs: 60_000, // per HTTP request
  maxRetries: 2,
  fetch: customFetch, // optional
});
```

## Also available

- **MCP server** for Claude, ChatGPT, Cursor and any MCP client: `https://api.geogridapi.io/mcp`
- **Python**: `pip install geogridapi`, and `pip install langchain-geogridapi` for LangChain agents
- **No-code**: n8n node, Apify Actor, Make, Zapier ([guide](https://geogridapi.io/en/docs/no-code))
- [API reference](https://geogridapi.io/en/docs) · [OpenAPI specification](https://geogridapi.io/openapi.json)

## License

[MIT](LICENSE)
