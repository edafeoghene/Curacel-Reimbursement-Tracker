import { describe, expect, it } from "vitest";

import {
  APPROVALS_HEADERS,
  AUDIT_LOG_HEADERS,
  TICKETS_HEADERS,
} from "@curacel/shared";

import {
  parseApprovalRows,
  parseAuditRows,
  parseTicketRows,
  rowToApproval,
  rowToAuditLogEntry,
  rowToTicket,
} from "./parsers";

// Build a row in TICKETS_HEADERS column order from a partial record.
function ticketRow(overrides: Partial<Record<(typeof TICKETS_HEADERS)[number], string | number>> = {}): unknown[] {
  const defaults: Record<(typeof TICKETS_HEADERS)[number], string | number> = {
    tracking_id: "EXP-2605-AAAA",
    created_at: "2026-05-10T10:00:00Z",
    source_message_ts: "1715335200.000100",
    source_channel_id: "C0123",
    requester_user_id: "U0REQ",
    requester_name: "Alice",
    description: "Lunch",
    category: "meals",
    amount: 25,
    currency: "NGN",
    receipt_file_id: "F0RCPT",
    receipt_file_url: "https://files.slack.com/...",
    status: "AWAITING_APPROVAL",
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "U0APP",
    payment_confirmation_file_id: "",
    updated_at: "2026-05-10T10:00:00Z",
    row_version: 1,
  };
  const merged = { ...defaults, ...overrides };
  return TICKETS_HEADERS.map((h) => merged[h]);
}

function approvalRow(overrides: Partial<Record<(typeof APPROVALS_HEADERS)[number], string | number>> = {}): unknown[] {
  const defaults: Record<(typeof APPROVALS_HEADERS)[number], string | number> = {
    approval_id: "uuid-1",
    tracking_id: "EXP-2605-AAAA",
    step_number: 1,
    approver_user_id: "U0APP",
    approver_name: "Bob",
    decision: "PENDING",
    decided_at: "",
    comment: "",
    delegated_to_user_id: "",
    dm_channel_id: "D0CHAN",
    message_ts: "1715335300.000200",
  };
  const merged = { ...defaults, ...overrides };
  return APPROVALS_HEADERS.map((h) => merged[h]);
}

function auditRow(overrides: Partial<Record<(typeof AUDIT_LOG_HEADERS)[number], string>> = {}): unknown[] {
  const defaults: Record<(typeof AUDIT_LOG_HEADERS)[number], string> = {
    log_id: "uuid-log-1",
    tracking_id: "EXP-2605-AAAA",
    timestamp: "2026-05-10T10:00:00Z",
    actor_user_id: "U0REQ",
    event_type: "TICKET_CREATED",
    details_json: "{}",
  };
  const merged = { ...defaults, ...overrides };
  return AUDIT_LOG_HEADERS.map((h) => merged[h]);
}

describe("rowToTicket", () => {
  it("parses a full row in column order", () => {
    const row = ticketRow();
    const t = rowToTicket(row);
    expect(t.tracking_id).toBe("EXP-2605-AAAA");
    expect(t.amount).toBe(25);
    expect(t.current_step).toBe(1);
    expect(t.row_version).toBe(1);
    expect(t.payment_confirmation_file_id).toBeNull();
  });

  it("preserves a non-empty payment_confirmation_file_id verbatim", () => {
    const row = ticketRow({ payment_confirmation_file_id: "F0PAID" });
    expect(rowToTicket(row).payment_confirmation_file_id).toBe("F0PAID");
  });

  it("throws on a malformed amount", () => {
    const row = ticketRow({ amount: "not-a-number" });
    expect(() => rowToTicket(row)).toThrow(/malformed amount/);
  });

  it("throws on an unknown status", () => {
    const row = ticketRow({ status: "MAGIC_STATUS" });
    expect(() => rowToTicket(row)).toThrow(/unknown status/);
  });

  it("throws on a malformed row_version", () => {
    const row = ticketRow({ row_version: "" });
    expect(() => rowToTicket(row)).toThrow(/malformed row_version/);
  });
});

describe("rowToApproval", () => {
  it("parses a PENDING approval with empty decided_at + delegated_to_user_id as nulls", () => {
    const a = rowToApproval(approvalRow());
    expect(a.decision).toBe("PENDING");
    expect(a.decided_at).toBeNull();
    expect(a.delegated_to_user_id).toBeNull();
  });

  it("preserves a non-empty decided_at and delegated_to_user_id", () => {
    const a = rowToApproval(
      approvalRow({
        decision: "APPROVED",
        decided_at: "2026-05-10T11:00:00Z",
        delegated_to_user_id: "U0NEW",
      }),
    );
    expect(a.decision).toBe("APPROVED");
    expect(a.decided_at).toBe("2026-05-10T11:00:00Z");
    expect(a.delegated_to_user_id).toBe("U0NEW");
  });

  it("throws on an unknown decision", () => {
    expect(() => rowToApproval(approvalRow({ decision: "MAYBE" }))).toThrow(/unknown decision/);
  });

  it("throws on a malformed step_number", () => {
    expect(() => rowToApproval(approvalRow({ step_number: "x" }))).toThrow(/malformed step_number/);
  });
});

describe("rowToAuditLogEntry", () => {
  it("parses a row with details_json passed through verbatim", () => {
    const e = rowToAuditLogEntry(auditRow({ details_json: '{"key":"value"}' }));
    expect(e.event_type).toBe("TICKET_CREATED");
    expect(e.details_json).toBe('{"key":"value"}');
  });
});

describe("bulk parsers tolerate blank and malformed rows", () => {
  it("parseTicketRows skips blank rows but not valid ones", () => {
    const result = parseTicketRows([ticketRow(), [], ticketRow({ tracking_id: "EXP-2605-BBBB" })]);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it("parseTicketRows counts malformed rows in `skipped` and returns the rest", () => {
    const good = ticketRow();
    const bad = ticketRow({ amount: "broken" });
    const result = parseTicketRows([good, bad, ticketRow({ tracking_id: "EXP-2605-CCCC" })]);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("parseApprovalRows skips a row whose first column is empty", () => {
    const blank: unknown[] = ["", "", "", "", "", "", "", "", "", "", ""];
    const result = parseApprovalRows([approvalRow(), blank, approvalRow({ approval_id: "uuid-2" })]);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it("parseAuditRows returns an empty list for an empty input", () => {
    expect(parseAuditRows([])).toEqual({ rows: [], skipped: 0 });
  });
});
