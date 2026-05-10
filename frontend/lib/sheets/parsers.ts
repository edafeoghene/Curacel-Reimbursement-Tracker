// Pure row → object parsers. No I/O, no env reads — they take the raw rows
// returned by sheets.spreadsheets.values.get() and turn them into typed
// objects from @curacel/shared.
//
// Tolerant of malformed individual rows: callers receive a list of
// successfully-parsed rows; rows that fail validation are skipped (and
// counted in the optional `skipped` return).

import {
  APPROVAL_DECISIONS,
  APPROVALS_HEADERS,
  AUDIT_LOG_HEADERS,
  TICKET_STATUSES,
  TICKETS_HEADERS,
  type Approval,
  type ApprovalDecision,
  type AuditLogEntry,
  type Status,
  type Ticket,
} from "@curacel/shared";

function isStatus(v: string): v is Status {
  return (TICKET_STATUSES as readonly string[]).includes(v);
}

function isApprovalDecision(v: string): v is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(v);
}

function cellAt(row: unknown[], i: number): string {
  const v = row[i];
  if (v === undefined || v === null) return "";
  return String(v);
}

function isBlankRow(row: unknown[]): boolean {
  if (!row || row.length === 0) return true;
  // First column being empty = blank row by sheet convention (every row
  // has a primary key in column A).
  return row[0] === undefined || row[0] === null || String(row[0]) === "";
}

// ---------- Ticket ----------

export function rowToTicket(row: unknown[]): Ticket {
  const get = (h: (typeof TICKETS_HEADERS)[number]): string =>
    cellAt(row, TICKETS_HEADERS.indexOf(h));

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

// ---------- Approval ----------

export function rowToApproval(row: unknown[]): Approval {
  const get = (h: (typeof APPROVALS_HEADERS)[number]): string =>
    cellAt(row, APPROVALS_HEADERS.indexOf(h));

  const stepStr = get("step_number");
  const step = stepStr === "" ? NaN : Number(stepStr);
  if (!Number.isFinite(step)) {
    throw new Error(`Approval row has malformed step_number: ${JSON.stringify(stepStr)}`);
  }

  const decision = get("decision");
  if (!isApprovalDecision(decision)) {
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

// ---------- AuditLogEntry ----------

export function rowToAuditLogEntry(row: unknown[]): AuditLogEntry {
  const get = (h: (typeof AUDIT_LOG_HEADERS)[number]): string =>
    cellAt(row, AUDIT_LOG_HEADERS.indexOf(h));

  return {
    log_id: get("log_id"),
    tracking_id: get("tracking_id"),
    timestamp: get("timestamp"),
    actor_user_id: get("actor_user_id"),
    event_type: get("event_type"),
    details_json: get("details_json"),
  };
}

// ---------- Bulk parsers — skip blank/malformed rows ----------

interface ParseResult<T> {
  rows: T[];
  /** Count of malformed rows skipped. Useful for surfacing data-quality issues. */
  skipped: number;
}

function parseRows<T>(
  raw: unknown[][],
  parse: (row: unknown[]) => T,
): ParseResult<T> {
  const out: T[] = [];
  let skipped = 0;
  for (const row of raw) {
    if (isBlankRow(row)) continue;
    try {
      out.push(parse(row));
    } catch {
      skipped++;
    }
  }
  return { rows: out, skipped };
}

export const parseTicketRows = (raw: unknown[][]): ParseResult<Ticket> =>
  parseRows(raw, rowToTicket);

export const parseApprovalRows = (raw: unknown[][]): ParseResult<Approval> =>
  parseRows(raw, rowToApproval);

export const parseAuditRows = (raw: unknown[][]): ParseResult<AuditLogEntry> =>
  parseRows(raw, rowToAuditLogEntry);
