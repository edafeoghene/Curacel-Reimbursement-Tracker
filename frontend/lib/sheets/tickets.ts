import {
  TAB_TICKETS,
  TICKETS_HEADERS,
  type Status,
  type Ticket,
} from "@curacel/shared";

import { dataRange, getSheetsClient } from "./client";
import { parseTicketRows } from "./parsers";

const NUM_COLS = TICKETS_HEADERS.length;

async function readAllRawTicketRows(): Promise<unknown[][]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_TICKETS, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

/**
 * Filters the queue page applies. Each is optional and anded together;
 * an empty/undefined filter is a no-op.
 *
 * Date filters compare against `created_at` (ISO 8601 strings sort
 * lexicographically the same as chronologically, so string compare is fine).
 */
export interface TicketListFilters {
  status?: Status;
  requesterUserId?: string;
  routeId?: string;
  currency?: string;
  /** ISO date or full ISO timestamp. Inclusive lower bound on created_at. */
  createdFrom?: string;
  /** ISO date or full ISO timestamp. Inclusive upper bound on created_at. */
  createdTo?: string;
}

export function applyTicketFilters(
  tickets: readonly Ticket[],
  filters: TicketListFilters | undefined,
): Ticket[] {
  if (!filters) return [...tickets];
  return tickets.filter((t) => {
    if (filters.status && t.status !== filters.status) return false;
    if (filters.requesterUserId && t.requester_user_id !== filters.requesterUserId) return false;
    if (filters.routeId && t.route_id !== filters.routeId) return false;
    if (filters.currency && t.currency !== filters.currency) return false;
    if (filters.createdFrom && t.created_at < filters.createdFrom) return false;
    if (filters.createdTo && t.created_at > filters.createdTo) return false;
    return true;
  });
}

/**
 * Read every ticket from the sheet, optionally filtered, sorted by
 * `created_at` descending (newest first).
 */
export async function listAllTickets(
  filters?: TicketListFilters,
): Promise<Ticket[]> {
  const raw = await readAllRawTicketRows();
  const { rows } = parseTicketRows(raw);
  const filtered = applyTicketFilters(rows, filters);
  filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return filtered;
}

export async function getTicketByTrackingId(trackingId: string): Promise<Ticket | null> {
  if (!trackingId) return null;
  const raw = await readAllRawTicketRows();
  const { rows } = parseTicketRows(raw);
  return rows.find((t) => t.tracking_id === trackingId) ?? null;
}
