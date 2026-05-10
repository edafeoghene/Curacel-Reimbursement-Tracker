import {
  AUDIT_LOG_HEADERS,
  TAB_AUDIT_LOG,
  type AuditLogEntry,
} from "@curacel/shared";

import { dataRange, getSheetsClient } from "./client";
import { parseAuditRows } from "./parsers";

const NUM_COLS = AUDIT_LOG_HEADERS.length;

async function readAllRawAuditRows(): Promise<unknown[][]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_AUDIT_LOG, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

/**
 * All audit-log entries belonging to a single ticket, sorted by timestamp
 * ascending so the detail page reads as a chronology (oldest event first).
 */
export async function listAuditEntriesForTicket(trackingId: string): Promise<AuditLogEntry[]> {
  if (!trackingId) return [];
  const raw = await readAllRawAuditRows();
  const { rows } = parseAuditRows(raw);
  return rows
    .filter((e) => e.tracking_id === trackingId)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}
