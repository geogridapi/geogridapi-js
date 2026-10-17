// Types of the GeoGridAPI REST API (https://geogridapi.io/openapi.json).
// Field names match the JSON payloads (snake_case).

export type GridShape = "square" | "circle" | "diamond" | "hexagon" | "cross" | "ellipse" | "rectangle";
export type GridDensity = "low" | "medium" | "high";
export type GridSize = 3 | 5 | 7 | 9;
export type GridStatus = "pending" | "running" | "completed" | "failed";
export type KeyMode = "live" | "test";

export interface Center {
  lat: number;
  lng: number;
}

/** Format shared by a grid, an estimate and a batch. */
export interface GridFormat {
  /** Grid shape (default `square`). */
  shape?: GridShape;
  /** Square only (default 7): side of the grid, size × size points. */
  size?: GridSize;
  /** Other shapes only (default `medium`). */
  density?: GridDensity;
  /** Distance from center to edge, 0.5 to 30 km (other shapes: from 1 km). */
  radius_km?: number;
  /** Search language, 2-letter code. Defaults to the account language. */
  language?: string;
  /** Search country, 2-letter ISO code. */
  country?: string;
  /** Public HTTPS URL called with the grid when it ends (`grid.completed` or `grid.failed`). */
  webhook_url?: string;
}

interface TargetBase {
  /** Keyword searched on Google Maps. */
  keyword: string;
  /** Grid center; defaults to the listing's location. */
  center?: Center;
}

/** The listing to measure: a Google place id, or a name and city (first match). */
export type GridTarget = TargetBase &
  ({ place_id: string; query?: never } | { query: string; place_id?: never });

export type CreateGridParams = GridTarget & GridFormat;

export interface Place {
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number;
  lng: number;
}

/** A listing named without its coordinates (history, batch items). */
export type PlaceRef = Pick<Place, "place_id" | "name" | "address">;

/** Why a grid or a batch item failed. */
export interface GridError {
  code: string;
  message: string;
}

/** A search result; `lat`/`lng` are `null` when Google gives no public location (service-area business). */
export interface FoundPlace extends PlaceRef {
  lat: number | null;
  lng: number | null;
}

export interface PlaceList {
  object: "list";
  data: FoundPlace[];
}

export interface GridSummary {
  /** Mean rank over the points where the listing appears. */
  average_rank: number | null;
  /** Mean rank with misses counted as 21. */
  average_rank_with_misses: number | null;
  top3_points: number;
  found_points: number;
}

export interface TopListing {
  rank: number;
  place_id: string;
  name: string;
}

export interface GridPoint {
  /** 0 = north. */
  row: number;
  /** 0 = west. */
  col: number;
  lat: number;
  lng: number;
  /** Position in the Google Maps results at this point; `null` = not in the top 20. */
  rank: number | null;
  /** Top 3 listings at this point. */
  top: TopListing[];
}

export interface Competitor {
  place_id: string;
  name: string;
  /** Points where it is in the top 3. */
  top3_points: number;
  /** Points where it ranks first. */
  first_points: number;
  /** Points where it ranks ahead of your listing. */
  ahead_points: number;
}

/** Change since the previous grid of the same map (same listing, keyword, format, radius and center). */
export interface PreviousGrid {
  grid_id: string;
  created_at: string;
  average_rank: number | null;
  top3_points: number;
  found_points: number;
  changes: {
    /** Negative = better. */
    average_rank: number | null;
    top3_points: number;
    found_points: number;
  };
  ranks: (number | null)[][];
  /** Places gained per cell (positive = better, a miss counts as 21). */
  rank_changes: (number | null)[][];
  points: { improved: number; worsened: number; unchanged: number };
}

export interface Grid {
  id: string;
  object: "grid";
  status: GridStatus;
  mode: KeyMode;
  source: "api" | "mcp" | "console";
  api_key_id: string | null;
  place: Place;
  keyword: string;
  shape: GridShape;
  density: GridDensity | null;
  size: number;
  rows: number;
  cols: number;
  radius_km: number;
  language: string;
  country: string | null;
  /** Grid points measured (points at sea are neither measured nor charged). */
  points_total: number;
  /** Credits charged (0 with a test key). */
  points_charged: number;
  summary: GridSummary | null;
  /** rows × cols matrix, row 0 = north, column 0 = west. `null` = not in the top 20 (or outside the shape). */
  ranks: (number | null)[][] | null;
  points?: GridPoint[] | null;
  /** Who ranks ahead: the top 3 listings summed over the map. */
  competitors?: Competitor[] | null;
  previous?: PreviousGrid | null;
  /** Why the grid failed (`null` unless `status` is `failed`). */
  error: GridError | null;
  /** Delivery of the `webhook_url`, when one was given. */
  webhook?: { status: string | null; attempts: number } | null;
  created_at: string;
  completed_at: string | null;
}

export interface ListGridsParams {
  /** 1 to 100 (default 20). */
  limit?: number;
  /** `next_before` of the previous page. */
  before?: string;
  place_id?: string;
  /** Exact keyword, case-insensitive. */
  keyword?: string;
}

export interface GridList {
  object: "list";
  data: Grid[];
  has_more: boolean;
  /** Pass as `before` to read the next page. */
  next_before: string | null;
}

export interface Estimate {
  object: "estimate";
  shape: GridShape;
  size: number;
  density: GridDensity | null;
  rows: number;
  cols: number;
  radius_km: number;
  /** Points that will be measured (points at sea removed). */
  points: number;
  points_at_sea: number;
  /** `false`: the listing could not be located, `points` is an upper bound. */
  exact: boolean;
  /** Credits the grid will cost. */
  credits: number;
  balance?: number;
  balance_after?: number;
  enough?: boolean;
  place: Place | null;
}

export type HistoryParams = { limit?: number } & (
  | { grid_id: string; place_id?: never; keyword?: never }
  | { place_id: string; keyword: string; grid_id?: never }
);

export interface HistoryEntry {
  grid_id: string;
  created_at: string;
  average_rank: number | null;
  top3_points: number;
  found_points: number;
  points_total: number;
}

export interface History {
  object: "history";
  reference_grid_id: string;
  mode: KeyMode;
  place: PlaceRef;
  keyword: string;
  shape: GridShape;
  density: GridDensity | null;
  size: number;
  rows: number;
  cols: number;
  radius_km: number;
  /** Completed grids of the same map, oldest first. */
  data: HistoryEntry[];
  has_more: boolean;
  change: {
    since: string;
    /** Negative = better. */
    average_rank: number | null;
    top3_points: number;
    found_points: number;
  } | null;
}

export type CreateBatchParams = GridFormat & {
  /** 1 to 50 grids: one listing with several keywords, or several listings with one keyword. */
  items: GridTarget[];
};

export type BatchItemStatus = "queued" | "pending" | "running" | "completed" | "failed";

export interface BatchItem {
  index: number;
  keyword: string;
  query: string | null;
  place: PlaceRef | null;
  status: BatchItemStatus;
  grid_id: string | null;
  points_total: number | null;
  points_charged: number;
  summary: Pick<GridSummary, "average_rank" | "top3_points" | "found_points"> | null;
  error: GridError | null;
}

export interface Batch {
  id: string;
  object: "batch";
  status: "running" | "completed";
  mode: KeyMode;
  source: "api" | "mcp" | "console";
  shape: GridShape;
  size: number;
  density: GridDensity | null;
  radius_km: number;
  items_count: number;
  counts: Record<BatchItemStatus, number>;
  credits_estimated: number;
  credits_charged: number;
  items: BatchItem[];
  created_at: string;
  launched_at: string | null;
}

export interface CreateScheduleParams {
  /** An existing completed grid to repeat. */
  grid_id: string;
  frequency: "weekly" | "monthly";
  /** Weekly: 1 = Monday … 7 = Sunday (default 1). */
  weekday?: number;
  /** Monthly: day of the month, 1 to 28 (default 1). */
  month_day?: number;
}

export interface Schedule {
  id: string;
  object: "schedule";
  status: "active" | "paused" | "stopped";
  stopped_reason: string | null;
  mode: KeyMode;
  frequency: "weekly" | "monthly";
  weekday: number | null;
  month_day: number | null;
  /** The listing and the grid center. */
  place: Pick<Place, "place_id" | "name" | "lat" | "lng">;
  keyword: string;
  shape: GridShape;
  density: GridDensity | null;
  size: number;
  radius_km: number;
  points_per_run: number;
  credits_per_month: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_grid_id: string | null;
  source_grid_id: string | null;
  runs_count: number;
  created_at: string;
}

export interface ScheduleList {
  object: "list";
  data: Schedule[];
}

export interface Balance {
  object: "balance";
  /** Credits left (1 credit = 1 grid point). */
  points: number;
  mode: KeyMode;
}

export type WebhookEventType = "grid.completed" | "grid.failed";

export interface WebhookEvent {
  id: string;
  object: "event";
  type: WebhookEventType;
  created_at: string;
  data: Grid;
}
