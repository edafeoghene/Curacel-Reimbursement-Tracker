// Routes loader with periodic refresh. Routes are config — small, read-mostly,
// edited manually by ops. Loaded into memory at boot, refreshed every 5 minutes.
// Malformed rows fail loudly per PLAN.md §14.

import { dataRange, getSheetsClient } from "./client.js";
import { ROUTES_HEADERS, TAB_ROUTES } from "./schema.js";
import type { Route } from "../types.js";

const NUM_COLS = ROUTES_HEADERS.length;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let cache: Route[] | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export class RoutesNotLoadedError extends Error {
  constructor() {
    super(
      "Routes have not been loaded yet. Call loadRoutes() at boot before getCachedRoutes().",
    );
    this.name = "RoutesNotLoadedError";
  }
}

export class MalformedRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedRouteError";
  }
}

// ---------- pure parsing ----------

function parseCsvList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse one raw routes-sheet row (an unknown[]) into a Route. Pure function
 * — no I/O, no caching. Throws MalformedRouteError on bad data.
 */
export function parseRouteRow(raw: unknown[]): Route {
  const cell = (i: number): string => {
    const v = raw[i];
    if (v === undefined || v === null) return "";
    return String(v).trim();
  };
  const idx = (h: (typeof ROUTES_HEADERS)[number]): number => ROUTES_HEADERS.indexOf(h);

  const route_id = cell(idx("route_id"));
  if (!route_id) throw new MalformedRouteError(`route_id is required (row: ${JSON.stringify(raw)})`);

  const currency = cell(idx("currency"));
  if (!currency) {
    throw new MalformedRouteError(`route ${route_id}: currency is required`);
  }

  const minStr = cell(idx("min_amount"));
  if (minStr === "") {
    throw new MalformedRouteError(`route ${route_id}: min_amount is required`);
  }
  const min_amount = Number(minStr);
  if (!Number.isFinite(min_amount)) {
    throw new MalformedRouteError(
      `route ${route_id}: min_amount is not numeric (got ${JSON.stringify(minStr)})`,
    );
  }

  const maxStr = cell(idx("max_amount"));
  let max_amount: number | null;
  if (maxStr === "") {
    max_amount = null;
  } else {
    const n = Number(maxStr);
    if (!Number.isFinite(n)) {
      throw new MalformedRouteError(
        `route ${route_id}: max_amount is not numeric (got ${JSON.stringify(maxStr)})`,
      );
    }
    max_amount = n;
  }

  if (max_amount !== null && max_amount <= min_amount) {
    throw new MalformedRouteError(
      `route ${route_id}: max_amount (${max_amount}) must be > min_amount (${min_amount}) or empty`,
    );
  }

  const category_filter = parseCsvList(cell(idx("category_filter")));

  const approvers = parseCsvList(cell(idx("approvers_csv")));
  if (approvers.length === 0) {
    throw new MalformedRouteError(
      `route ${route_id}: approvers_csv must contain at least one Slack user ID`,
    );
  }

  return { route_id, currency, min_amount, max_amount, category_filter, approvers };
}

// ---------- I/O ----------

/**
 * Hit the sheet, parse all rows, replace the in-memory cache. Throws on any
 * malformed row.
 */
export async function loadRoutes(): Promise<Route[]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_ROUTES, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as unknown[][];

  const out: Route[] = [];
  for (const raw of rows) {
    if (!raw || raw.length === 0) continue;
    if (raw[0] === undefined || raw[0] === null || String(raw[0]).trim() === "") continue;
    out.push(parseRouteRow(raw));
  }
  cache = out;
  return out;
}

/** Synchronous accessor. Throws if loadRoutes() hasn't completed yet. */
export function getCachedRoutes(): Route[] {
  if (cache === null) throw new RoutesNotLoadedError();
  return cache;
}

/**
 * Begin periodic refresh. Safe to call multiple times — extra calls clear the
 * previous timer first. Errors during a refresh are logged but do not crash:
 * the previous cache stays intact.
 */
export function startRoutesRefresh(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadRoutes().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[routes] periodic refresh failed:", err);
    });
  }, intervalMs);
  // Don't keep the process alive solely for this timer.
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

/** Stop periodic refresh. Used by graceful shutdown. */
export function stopRoutesRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test-only helper: drop the cache so a fresh loadRoutes() is required. */
export function __resetRoutesCacheForTests(): void {
  cache = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
