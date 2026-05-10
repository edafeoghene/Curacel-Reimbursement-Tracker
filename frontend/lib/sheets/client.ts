// Read-only Google Sheets client for the FM dashboard. Mirrors the bot's
// auth shape (src/sheets/client.ts) so they share env-var names and the
// service-account decoding rules — but this module never writes back.

import { google, type sheets_v4 } from "googleapis";

let cached: { sheets: sheets_v4.Sheets; spreadsheetId: string } | null = null;

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
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
 * Lazily build (and memoize) a `sheets_v4.Sheets` instance bound to the
 * spreadsheet ID. Subsequent calls return the same handle. The scope is
 * `spreadsheets.readonly` — the frontend is structurally incapable of
 * writing back even if a future bug tried to.
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

// ---------- A1 / range helpers (mirrors src/sheets/client.ts) ----------

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

export function quoteTab(tab: string): string {
  if (/^[A-Za-z0-9_]+$/.test(tab)) return tab;
  return `'${tab.replace(/'/g, "''")}'`;
}

/** Build a full-data range covering rows 2..end across the schema columns. */
export function dataRange(tab: string, numCols: number, startRow = 2, endRow = 100000): string {
  if (startRow < 1 || endRow < 1) {
    throw new Error(`dataRange: rows are 1-based, got ${startRow}..${endRow}`);
  }
  const startCol = columnIndexToA1(0);
  const endCol = columnIndexToA1(numCols - 1);
  return `${quoteTab(tab)}!${startCol}${startRow}:${endCol}${endRow}`;
}
