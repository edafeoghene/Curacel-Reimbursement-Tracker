// Approvals CRUD. Append-only, with one allowed update per row to flip decision
// (and a small set of related fields). No row_version — repeated identical
// updates from the same step are idempotent.

import type { sheets_v4 } from "googleapis";
import {
  buildRange,
  dataRange,
  getSheetsClient,
  headerRange,
} from "./client.js";
import { enqueueWrite } from "./queue.js";
import { APPROVALS_HEADERS, TAB_APPROVALS } from "@curacel/shared";
import type { Approval, ApprovalDecision } from "@curacel/shared";
import { APPROVAL_DECISIONS } from "@curacel/shared";

export class ApprovalNotFoundError extends Error {
  constructor(public readonly approvalId: string) {
    super(`Approval not found: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

const NUM_COLS = APPROVALS_HEADERS.length;

function isDecision(v: string): v is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(v);
}

function cellFor(value: Approval[keyof Approval]): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  return String(value);
}

function approvalToRow(a: Approval): (string | number)[] {
  return APPROVALS_HEADERS.map((h) => cellFor(a[h]));
}

function rowToApproval(row: unknown[]): Approval {
  const cell = (i: number): string => {
    const v = row[i];
    if (v === undefined || v === null) return "";
    return String(v);
  };
  const get = (h: (typeof APPROVALS_HEADERS)[number]): string =>
    cell(APPROVALS_HEADERS.indexOf(h));

  const stepStr = get("step_number");
  const step = stepStr === "" ? NaN : Number(stepStr);
  if (!Number.isFinite(step)) {
    throw new Error(`Approval row has malformed step_number: ${JSON.stringify(stepStr)}`);
  }

  const decision = get("decision");
  if (!isDecision(decision)) {
    throw new Error(`Approval row has unknown decision: ${JSON.stringify(decision)}`);
  }

  const decidedAt = get("decided_at");
  const delegatedTo = get("delegated_to_user_id");

  return {
    approval_id: get("approval_id"),
    tracking_id: get("tracking_id"),
    step_number: step,
    approver_user_id: get("approver_user_id"),
    approver_name: get("approver_name"),
    decision,
    decided_at: decidedAt === "" ? null : decidedAt,
    comment: get("comment"),
    delegated_to_user_id: delegatedTo === "" ? null : delegatedTo,
    dm_channel_id: get("dm_channel_id"),
    message_ts: get("message_ts"),
  };
}

interface RowHit {
  approval: Approval;
  sheetRowIndex: number;
}

async function readAllRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<unknown[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange(TAB_APPROVALS, NUM_COLS),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

function findRowBy(
  rows: unknown[][],
  predicate: (a: Approval) => boolean,
): RowHit | null {
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.length === 0) continue;
    if (raw[0] === undefined || raw[0] === null || String(raw[0]) === "") continue;
    let parsed: Approval;
    try {
      parsed = rowToApproval(raw);
    } catch {
      continue;
    }
    if (predicate(parsed)) return { approval: parsed, sheetRowIndex: i + 2 };
  }
  return null;
}

// ---------- public API ----------

export async function appendApproval(a: Approval): Promise<void> {
  await enqueueWrite(async () => {
    const { sheets, spreadsheetId } = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: headerRange(TAB_APPROVALS, NUM_COLS),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [approvalToRow(a)] },
    });
  });
}

export async function listApprovalsForTicket(trackingId: string): Promise<Approval[]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const rows = await readAllRows(sheets, spreadsheetId);
  const out: Approval[] = [];
  for (const raw of rows) {
    if (!raw || raw.length === 0) continue;
    if (raw[0] === undefined || raw[0] === null || String(raw[0]) === "") continue;
    let parsed: Approval;
    try {
      parsed = rowToApproval(raw);
    } catch {
      continue;
    }
    if (parsed.tracking_id === trackingId) out.push(parsed);
  }
  // Stable order by step_number.
  out.sort((a, b) => a.step_number - b.step_number);
  return out;
}

/**
 * Update a subset of fields on an approval row. Idempotent: if the same patch
 * is applied twice, the row ends up identical. No row_version.
 */
export async function updateApprovalDecision(
  approvalId: string,
  patch: Partial<
    Pick<
      Approval,
      | "decision"
      | "decided_at"
      | "comment"
      | "delegated_to_user_id"
      | "approver_user_id"
      | "approver_name"
      | "dm_channel_id"
      | "message_ts"
    >
  >,
): Promise<void> {
  await enqueueWrite(async () => {
    const { sheets, spreadsheetId } = await getSheetsClient();
    const rows = await readAllRows(sheets, spreadsheetId);
    const hit = findRowBy(rows, (a) => a.approval_id === approvalId);
    if (!hit) throw new ApprovalNotFoundError(approvalId);

    const updated: Approval = { ...hit.approval, ...patch };
    const range = buildRange(
      TAB_APPROVALS,
      hit.sheetRowIndex,
      hit.sheetRowIndex,
      0,
      NUM_COLS - 1,
    );
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [approvalToRow(updated)] },
    });
  });
}
