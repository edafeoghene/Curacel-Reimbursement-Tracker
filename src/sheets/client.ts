// Sheets API client — service-account auth and shared helpers.
// Reads the only two env vars the sheets layer is allowed to read:
//   GOOGLE_SERVICE_ACCOUNT_B64 — base64'd service account JSON
//   GOOGLE_SHEETS_ID           — the workbook ID
// Both are validated upstream (src/config.ts) before anyone calls in.

import { google, sheets_v4 } from "googleapis";

let cached: { sheets: sheets_v4.Sheets; spreadsheetId: string } | null = null;

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  // other fields ignored; google-auth-library only needs email + key
}

function decodeServiceAccount(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 is not set — cannot initialize Sheets client.",
    );
  }
  let json: string;
  try {
    json = Buffer.from(raw, "base64").toString("utf8");
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_B64 is not valid base64: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_B64 did not decode to valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).client_email !== "string" ||
    typeof (parsed as Record<string, unknown>).private_key !== "string"
  ) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 JSON is missing required fields (client_email, private_key).",
    );
  }
  return parsed as ServiceAccountKey;
}

/**
 * Lazily build (and memoize) a `sheets_v4.Sheets` instance and the
 * spreadsheet ID. Subsequent calls return the same handle.
 */
export async function getSheetsClient(): Promise<{
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}> {
  if (cached) return cached;

  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    throw new Error(
      "GOOGLE_SHEETS_ID is not set — cannot initialize Sheets client.",
    );
  }

  const sa = decodeServiceAccount();

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: SCOPES,
  });
  await auth.authorize();

  const sheets = google.sheets({ version: "v4", auth });
  cached = { sheets, spreadsheetId };
  return cached;
}

/**
 * Test-only helper: drop the cached client. Not exported by index but available
 * for unit tests that need to swap env vars between cases.
 */
export function __resetSheetsClientForTests(): void {
  cached = null;
}

// ---------- A1 / range helpers ----------

/**
 * Convert a 0-based column index to spreadsheet A1 letters.
 *   0 -> "A", 25 -> "Z", 26 -> "AA", 701 -> "ZZ", 702 -> "AAA"
 */
export function columnIndexToA1(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`columnIndexToA1: index must be a non-negative integer, got ${index}`);
  }
  let n = index;
  let out = "";
  while (true) {
    const rem = n % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/**
 * Build a Sheets API range string of the form `tab!A1:Z9`.
 * `endColIndex` is inclusive and 0-based. If only the row range is needed
 * (entire row span) pass `endColIndex` for the last column.
 */
export function buildRange(
  tab: string,
  startRow: number,
  endRow: number,
  startColIndex: number,
  endColIndex: number,
): string {
  if (startRow < 1 || endRow < 1) {
    throw new Error(`buildRange: rows are 1-based, got ${startRow}..${endRow}`);
  }
  const startCol = columnIndexToA1(startColIndex);
  const endCol = columnIndexToA1(endColIndex);
  return `${quoteTab(tab)}!${startCol}${startRow}:${endCol}${endRow}`;
}

/** Build a header range covering the full first row of `tab`, given column count. */
export function headerRange(tab: string, numCols: number): string {
  return buildRange(tab, 1, 1, 0, numCols - 1);
}

/** Build a full-data range covering rows 2..end across the schema columns. */
export function dataRange(tab: string, numCols: number, startRow = 2, endRow?: number): string {
  const end = endRow ?? 100000; // generous upper bound; Sheets handles sparse ranges fine.
  return buildRange(tab, startRow, end, 0, numCols - 1);
}

/** Quote a tab name for inclusion in an A1 reference if it contains spaces or special chars. */
export function quoteTab(tab: string): string {
  if (/^[A-Za-z0-9_]+$/.test(tab)) return tab;
  return `'${tab.replace(/'/g, "''")}'`;
}
