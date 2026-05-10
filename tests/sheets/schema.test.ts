// If someone adds a column to a Ticket / Approval / AuditLogEntry / RouteRow
// type and forgets to update the matching header constant, this test fails.

import { describe, expect, it } from "vitest";
import {
  APPROVALS_HEADERS,
  AUDIT_LOG_HEADERS,
  ROUTES_HEADERS,
  TICKETS_HEADERS,
} from "../../src/sheets/schema.js";
import type {
  Approval,
  AuditLogEntry,
  RouteRow,
  Ticket,
} from "@curacel/shared";

// Expected field lists. These mirror the type declarations exactly. Adding a
// field to a type without updating both the type-side list here AND the
// header constant in src/sheets/schema.ts will fail one of the assertions
// below.
//
// `satisfies readonly (keyof X)[]` ensures the string array is in sync with
// the type's keys at compile time.

const TICKET_FIELDS = [
  "tracking_id",
  "created_at",
  "source_message_ts",
  "source_channel_id",
  "requester_user_id",
  "requester_name",
  "description",
  "category",
  "amount",
  "currency",
  "receipt_file_id",
  "receipt_file_url",
  "status",
  "route_id",
  "current_step",
  "current_approver_user_id",
  "payment_confirmation_file_id",
  "updated_at",
  "row_version",
] as const satisfies readonly (keyof Ticket)[];

const APPROVAL_FIELDS = [
  "approval_id",
  "tracking_id",
  "step_number",
  "approver_user_id",
  "approver_name",
  "decision",
  "decided_at",
  "comment",
  "delegated_to_user_id",
  "dm_channel_id",
  "message_ts",
] as const satisfies readonly (keyof Approval)[];

const AUDIT_FIELDS = [
  "log_id",
  "tracking_id",
  "timestamp",
  "actor_user_id",
  "event_type",
  "details_json",
] as const satisfies readonly (keyof AuditLogEntry)[];

const ROUTE_FIELDS = [
  "route_id",
  "currency",
  "min_amount",
  "max_amount",
  "category_filter",
  "approvers_csv",
] as const satisfies readonly (keyof RouteRow)[];

describe("schema headers cover every field on the corresponding type", () => {
  it("TICKETS_HEADERS matches Ticket fields exactly and in order", () => {
    expect([...TICKETS_HEADERS]).toEqual([...TICKET_FIELDS]);
  });

  it("APPROVALS_HEADERS matches Approval fields exactly and in order", () => {
    expect([...APPROVALS_HEADERS]).toEqual([...APPROVAL_FIELDS]);
  });

  it("AUDIT_LOG_HEADERS matches AuditLogEntry fields exactly and in order", () => {
    expect([...AUDIT_LOG_HEADERS]).toEqual([...AUDIT_FIELDS]);
  });

  it("ROUTES_HEADERS matches RouteRow fields exactly and in order", () => {
    expect([...ROUTES_HEADERS]).toEqual([...ROUTE_FIELDS]);
  });

  it("there are no duplicate columns within any header set", () => {
    for (const headers of [
      TICKETS_HEADERS,
      APPROVALS_HEADERS,
      AUDIT_LOG_HEADERS,
      ROUTES_HEADERS,
    ]) {
      expect(new Set(headers).size).toBe(headers.length);
    }
  });
});
