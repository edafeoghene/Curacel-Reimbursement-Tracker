import {
  APPROVALS_HEADERS,
  PAYMENT_STEP_SENTINEL,
  TAB_APPROVALS,
  type Approval,
} from "@curacel/shared";

import { dataRange, getSheetsClient } from "./client";
import { parseApprovalRows } from "./parsers";

const NUM_COLS = APPROVALS_HEADERS.length;

async function readAllRawApprovalRows(): Promise<unknown[][]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_APPROVALS, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

/**
 * Approval rows belonging to a single ticket, sorted by step_number
 * ascending (so the timeline reads top-down). The Mark-as-Paid sentinel
 * row (step_number = 99) is excluded — it's an internal coordinate
 * holder, not a real approval step (see PAYMENT_STEP_SENTINEL).
 */
export async function listApprovalsForTicket(trackingId: string): Promise<Approval[]> {
  if (!trackingId) return [];
  const raw = await readAllRawApprovalRows();
  const { rows } = parseApprovalRows(raw);
  return rows
    .filter((a) => a.tracking_id === trackingId && a.step_number !== PAYMENT_STEP_SENTINEL)
    .sort((a, b) => a.step_number - b.step_number);
}

/**
 * Every approval row across every ticket where decision === "PENDING".
 * Used by the workload page to count outstanding approvals per approver.
 * Excludes the payment sentinel row.
 */
export async function listPendingApprovals(): Promise<Approval[]> {
  const raw = await readAllRawApprovalRows();
  const { rows } = parseApprovalRows(raw);
  return rows.filter(
    (a) => a.decision === "PENDING" && a.step_number !== PAYMENT_STEP_SENTINEL,
  );
}
