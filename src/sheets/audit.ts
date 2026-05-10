// Append-only audit log. Never reads. Always queued.

import { v4 as uuidv4 } from "uuid";
import { getSheetsClient, headerRange } from "./client.js";
import { enqueueWrite } from "./queue.js";
import { AUDIT_LOG_HEADERS, TAB_AUDIT_LOG } from "./schema.js";
import type { AuditLogEntry } from "@curacel/shared";

const NUM_COLS = AUDIT_LOG_HEADERS.length;

function entryToRow(e: AuditLogEntry): string[] {
  return AUDIT_LOG_HEADERS.map((h) => {
    const v = e[h];
    return v === null || v === undefined ? "" : String(v);
  });
}

/**
 * Append an audit log entry. If `log_id` or `timestamp` are empty/falsy on
 * the input, sensible defaults are filled in (UUID and now-ISO).
 */
export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  const filled: AuditLogEntry = {
    ...entry,
    log_id: entry.log_id || uuidv4(),
    timestamp: entry.timestamp || new Date().toISOString(),
  };
  await enqueueWrite(async () => {
    const { sheets, spreadsheetId } = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: headerRange(TAB_AUDIT_LOG, NUM_COLS),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [entryToRow(filled)] },
    });
  });
}

export interface AuditPayload {
  tracking_id: string;
  actor_user_id: string;
  event_type: string;
  details: unknown;
}

/**
 * Fire-and-forget wrapper around `appendAuditLog` that fills in `log_id` +
 * `timestamp` automatically and swallows write errors with a console.warn.
 * Audit-log writes must never block the main flow — if the sheet is briefly
 * unreachable, the user-facing transition still succeeds and the missing
 * row can be reconstructed from the breadcrumb logs.
 */
export async function safeAudit(p: AuditPayload): Promise<void> {
  try {
    await appendAuditLog({
      log_id: uuidv4(),
      tracking_id: p.tracking_id,
      timestamp: new Date().toISOString(),
      actor_user_id: p.actor_user_id,
      event_type: p.event_type,
      details_json: JSON.stringify(p.details ?? {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audit] append failed for ${p.event_type}:`, err);
  }
}
