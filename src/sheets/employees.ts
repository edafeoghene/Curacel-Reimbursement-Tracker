// Employee directory loader. Drives team-lead approval routing.
//
// Reads the "Employee data" tab into memory at boot, refreshes every 5 minutes.
// Unlike `routes`, this tab is human-managed with display-friendly headers
// (some carrying trailing whitespace) and may contain partially-populated rows
// while ops backfill. Parse failures on a single row are LOGGED AND SKIPPED —
// they don't take the whole loader down. The submission path validates the
// row's usability (team lead present + distinct from requester, valid channel)
// and routes to MANUAL_REVIEW on any failure, so leniency here is safe.

import { dataRange, getSheetsClient } from "./client.js";
import { EMPLOYEES_HEADERS, TAB_EMPLOYEES } from "@curacel/shared";
import type { Employee } from "@curacel/shared";

const NUM_COLS = EMPLOYEES_HEADERS.length;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let cache: Employee[] | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export class EmployeesNotLoadedError extends Error {
  constructor() {
    super(
      "Employees have not been loaded yet. Call loadEmployees() at boot before getCachedEmployees().",
    );
    this.name = "EmployeesNotLoadedError";
  }
}

export class MalformedEmployeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEmployeeError";
  }
}

// ---------- pure parsing ----------

function cellAt(raw: unknown[], i: number): string {
  const v = raw[i];
  if (v === undefined || v === null) return "";
  // Sheet rows occasionally carry newlines/whitespace in names — trim once,
  // here, so every downstream consumer sees clean values.
  return String(v).trim();
}

/**
 * Parse one raw "Employee data" row into an Employee. Pure function — no I/O.
 * Only throws when the row can't be indexed (missing employee_slack_id);
 * other fields can be empty and are validated downstream at submission time.
 */
export function parseEmployeeRow(raw: unknown[]): Employee {
  const employee_slack_id = cellAt(raw, EMPLOYEES_HEADERS.indexOf("employee_slack_id"));
  if (!employee_slack_id) {
    throw new MalformedEmployeeError(
      `employee_slack_id is required (row: ${JSON.stringify(raw)})`,
    );
  }
  if (!/^U[A-Z0-9]+$/.test(employee_slack_id)) {
    throw new MalformedEmployeeError(
      `employee_slack_id ${JSON.stringify(employee_slack_id)} is not a Slack user ID (must start with U)`,
    );
  }

  return {
    employee_name: cellAt(raw, EMPLOYEES_HEADERS.indexOf("employee_name")),
    team_lead_name: cellAt(raw, EMPLOYEES_HEADERS.indexOf("team_lead_name")),
    team: cellAt(raw, EMPLOYEES_HEADERS.indexOf("team")),
    employee_slack_id,
    team_lead_slack_id: cellAt(raw, EMPLOYEES_HEADERS.indexOf("team_lead_slack_id")),
    team_channel_id: cellAt(raw, EMPLOYEES_HEADERS.indexOf("team_channel_id")),
  };
}

// ---------- in-memory shape ----------

/**
 * Look up an employee by their Slack user ID. Returns the LAST matching row
 * if duplicates exist — matches sheet edit-history intent (re-adding a person
 * lower down implies the older row is stale).
 */
export function lookupEmployeeBySlackId(
  employees: Employee[],
  slackId: string,
): Employee | null {
  for (let i = employees.length - 1; i >= 0; i--) {
    if (employees[i]!.employee_slack_id === slackId) return employees[i]!;
  }
  return null;
}

// ---------- I/O ----------

/**
 * Hit the sheet, parse all rows, replace the in-memory cache. Bad rows are
 * skipped with a warning (see module docstring for why).
 */
export async function loadEmployees(): Promise<Employee[]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_EMPLOYEES, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as unknown[][];

  const out: Employee[] = [];
  for (const raw of rows) {
    if (!raw || raw.length === 0) continue;
    // Skip entirely blank rows. Don't gate on column 0 alone because rows
    // missing a display name but carrying a valid Slack ID are still usable.
    if (raw.every((c) => c === undefined || c === null || String(c).trim() === "")) {
      continue;
    }
    try {
      out.push(parseEmployeeRow(raw));
    } catch (err) {
      if (err instanceof MalformedEmployeeError) {
        // eslint-disable-next-line no-console
        console.warn(`[employees] skipping row: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  cache = out;
  return out;
}

/** Synchronous accessor. Throws if loadEmployees() hasn't completed yet. */
export function getCachedEmployees(): Employee[] {
  if (cache === null) throw new EmployeesNotLoadedError();
  return cache;
}

/**
 * Convenience: lookup against the cached snapshot. Throws EmployeesNotLoadedError
 * if the cache is empty.
 */
export function lookupCachedEmployeeBySlackId(slackId: string): Employee | null {
  return lookupEmployeeBySlackId(getCachedEmployees(), slackId);
}

/**
 * Begin periodic refresh. Safe to call multiple times — extra calls clear the
 * previous timer first. Errors during a refresh are logged but do not crash:
 * the previous cache stays intact.
 */
export function startEmployeesRefresh(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadEmployees().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[employees] periodic refresh failed:", err);
    });
  }, intervalMs);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

/** Stop periodic refresh. Used by graceful shutdown. */
export function stopEmployeesRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test-only helper: drop the cache so a fresh loadEmployees() is required. */
export function __resetEmployeesCacheForTests(): void {
  cache = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

