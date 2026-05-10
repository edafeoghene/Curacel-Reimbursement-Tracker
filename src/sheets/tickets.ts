// Tickets CRUD with optimistic concurrency.
// All writes go through enqueueWrite(); reads run concurrently.
// row_version is checked on every update; mismatch -> retry up to 3 times,
// then RowVersionConflict.

import type { sheets_v4 } from "googleapis";
import {
  buildRange,
  dataRange,
  getSheetsClient,
  headerRange,
} from "./client.js";
import { enqueueWrite } from "./queue.js";
import { TAB_TICKETS, TICKETS_HEADERS } from "@curacel/shared";
import type { Status, Ticket } from "@curacel/shared";
import { isTerminalStatus, TICKET_STATUSES } from "@curacel/shared";

export class RowVersionConflict extends Error {
  constructor(
    public readonly trackingId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `RowVersionConflict on ticket ${trackingId}: expected row_version=${expected}, found ${actual}`,
    );
    this.name = "RowVersionConflict";
  }
}

export class TicketNotFoundError extends Error {
  constructor(public readonly trackingId: string) {
    super(`Ticket not found: ${trackingId}`);
    this.name = "TicketNotFoundError";
  }
}

const NUM_COLS = TICKETS_HEADERS.length;

// ---------- (de)serialization ----------

function isStatus(v: string): v is Status {
  return (TICKET_STATUSES as readonly string[]).includes(v);
}

/** Serialize a Ticket field to its sheet-cell form. */
function cellFor(value: Ticket[keyof Ticket]): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return value;
  return String(value);
}

/** Serialize an entire ticket to a sheet row, in column order. */
function ticketToRow(t: Ticket): (string | number)[] {
  return TICKETS_HEADERS.map((h) => cellFor(t[h]));
}

/** Parse a raw sheet row back into a Ticket. Throws on malformed numeric fields. */
function rowToTicket(row: unknown[]): Ticket {
  const cell = (i: number): string => {
    const v = row[i];
    if (v === undefined || v === null) return "";
    return String(v);
  };
  // Build a string-keyed bag first, then narrow.
  const get = (h: (typeof TICKETS_HEADERS)[number]): string =>
    cell(TICKETS_HEADERS.indexOf(h));

  const amountStr = get("amount");
  const amount = amountStr === "" ? NaN : Number(amountStr);
  if (!Number.isFinite(amount)) {
    throw new Error(`Ticket row has malformed amount: ${JSON.stringify(amountStr)}`);
  }

  const stepStr = get("current_step");
  const step = stepStr === "" ? NaN : Number(stepStr);
  if (!Number.isFinite(step)) {
    throw new Error(`Ticket row has malformed current_step: ${JSON.stringify(stepStr)}`);
  }

  const versionStr = get("row_version");
  const version = versionStr === "" ? NaN : Number(versionStr);
  if (!Number.isFinite(version)) {
    throw new Error(`Ticket row has malformed row_version: ${JSON.stringify(versionStr)}`);
  }

  const status = get("status");
  if (!isStatus(status)) {
    throw new Error(`Ticket row has unknown status: ${JSON.stringify(status)}`);
  }

  const paymentFile = get("payment_confirmation_file_id");

  return {
    tracking_id: get("tracking_id"),
    created_at: get("created_at"),
    source_message_ts: get("source_message_ts"),
    source_channel_id: get("source_channel_id"),
    requester_user_id: get("requester_user_id"),
    requester_name: get("requester_name"),
    description: get("description"),
    category: get("category"),
    amount,
    currency: get("currency"),
    receipt_file_id: get("receipt_file_id"),
    receipt_file_url: get("receipt_file_url"),
    status,
    route_id: get("route_id"),
    current_step: step,
    current_approver_user_id: get("current_approver_user_id"),
    payment_confirmation_file_id: paymentFile === "" ? null : paymentFile,
    updated_at: get("updated_at"),
    row_version: version,
  };
}

// ---------- low-level row scan ----------

interface RowHit {
  ticket: Ticket;
  /** 1-based row index in the sheet (row 1 is the header). */
  sheetRowIndex: number;
}

async function readAllRows(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<unknown[][]> {
  // Skip the header row.
  const range = dataRange(TAB_TICKETS, NUM_COLS);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

function findRowBy(
  rows: unknown[][],
  predicate: (t: Ticket) => boolean,
): RowHit | null {
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.length === 0) continue;
    // First column (tracking_id) being empty = blank row, skip.
    if (raw[0] === undefined || raw[0] === null || String(raw[0]) === "") continue;
    let parsed: Ticket;
    try {
      parsed = rowToTicket(raw);
    } catch {
      // Tolerate malformed individual rows during scans by skipping them; the
      // bootstrap script will catch schema mismatches.
      continue;
    }
    if (predicate(parsed)) {
      // sheetRowIndex = data row 0 -> sheet row 2 (header is row 1)
      return { ticket: parsed, sheetRowIndex: i + 2 };
    }
  }
  return null;
}

// ---------- public API ----------

/**
 * Append a brand-new ticket row. Caller is responsible for ensuring tracking_id
 * uniqueness (use getTicketByTrackingId() before calling).
 */
export async function appendTicket(t: Ticket): Promise<void> {
  await enqueueWrite(async () => {
    const { sheets, spreadsheetId } = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: headerRange(TAB_TICKETS, NUM_COLS),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [ticketToRow(t)] },
    });
  });
}

export async function getTicketByTrackingId(id: string): Promise<Ticket | null> {
  if (!id) return null;
  const { sheets, spreadsheetId } = await getSheetsClient();
  const rows = await readAllRows(sheets, spreadsheetId);
  const hit = findRowBy(rows, (t) => t.tracking_id === id);
  return hit ? hit.ticket : null;
}

export async function getTicketBySourceMessageTs(ts: string): Promise<Ticket | null> {
  if (!ts) return null;
  const { sheets, spreadsheetId } = await getSheetsClient();
  const rows = await readAllRows(sheets, spreadsheetId);
  const hit = findRowBy(rows, (t) => t.source_message_ts === ts);
  return hit ? hit.ticket : null;
}

export async function listNonTerminalTickets(): Promise<Ticket[]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const rows = await readAllRows(sheets, spreadsheetId);
  const out: Ticket[] = [];
  for (const raw of rows) {
    if (!raw || raw.length === 0) continue;
    if (raw[0] === undefined || raw[0] === null || String(raw[0]) === "") continue;
    let parsed: Ticket;
    try {
      parsed = rowToTicket(raw);
    } catch {
      continue;
    }
    if (!isTerminalStatus(parsed.status)) out.push(parsed);
  }
  return out;
}

/**
 * Optimistic-concurrency update. Re-reads the row, verifies row_version,
 * increments it, sets updated_at, writes back. Retries up to 3 times on
 * row_version mismatch, then throws RowVersionConflict.
 *
 * `patch` may NOT include tracking_id, row_version, or created_at — those are
 * managed here.
 */
export async function updateTicket(
  trackingId: string,
  expectedRowVersion: number,
  patch: Partial<Omit<Ticket, "tracking_id" | "row_version" | "created_at">>,
): Promise<Ticket> {
  return enqueueWrite(async () => {
    const { sheets, spreadsheetId } = await getSheetsClient();

    const MAX_ATTEMPTS = 3;
    let lastConflict: RowVersionConflict | null = null;
    let observedExpected = expectedRowVersion;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const rows = await readAllRows(sheets, spreadsheetId);
      const hit = findRowBy(rows, (t) => t.tracking_id === trackingId);
      if (!hit) throw new TicketNotFoundError(trackingId);

      if (hit.ticket.row_version !== observedExpected) {
        lastConflict = new RowVersionConflict(
          trackingId,
          observedExpected,
          hit.ticket.row_version,
        );
        // For subsequent retries we still expect the *same* version the caller
        // gave us. Optimistic concurrency means: if it changed under us, we
        // surface the conflict — we don't silently rebase the patch.
        // We intentionally do NOT update observedExpected here; we only retry
        // the read in case of a transient inconsistent read from the API.
        continue;
      }

      const updated: Ticket = {
        ...hit.ticket,
        ...patch,
        tracking_id: hit.ticket.tracking_id,
        created_at: hit.ticket.created_at,
        row_version: hit.ticket.row_version + 1,
        updated_at: new Date().toISOString(),
      };

      const range = buildRange(
        TAB_TICKETS,
        hit.sheetRowIndex,
        hit.sheetRowIndex,
        0,
        NUM_COLS - 1,
      );
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: [ticketToRow(updated)] },
      });
      return updated;
    }

    throw lastConflict ??
      new RowVersionConflict(trackingId, observedExpected, observedExpected);
  });
}
