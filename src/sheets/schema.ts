// Single source of truth for sheet column order.
// Header arrays here MUST match the field order in src/types.ts.
// CRUD modules import these constants — never hard-code header arrays elsewhere.

import type { Ticket, Approval, AuditLogEntry, RouteRow } from "@curacel/shared";

// The `satisfies` clauses below are compile-time guards: if a field is renamed
// in src/types.ts the corresponding header array will fail to typecheck.

export const TICKETS_HEADERS = [
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

export const APPROVALS_HEADERS = [
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

export const AUDIT_LOG_HEADERS = [
  "log_id",
  "tracking_id",
  "timestamp",
  "actor_user_id",
  "event_type",
  "details_json",
] as const satisfies readonly (keyof AuditLogEntry)[];

export const ROUTES_HEADERS = [
  "route_id",
  "currency",
  "min_amount",
  "max_amount",
  "category_filter",
  "approvers_csv",
] as const satisfies readonly (keyof RouteRow)[];

// Tab names used across the codebase.
export const TAB_TICKETS = "tickets";
export const TAB_APPROVALS = "approvals";
export const TAB_AUDIT_LOG = "audit_log";
export const TAB_ROUTES = "routes";

export const ALL_TABS = [
  { name: TAB_TICKETS, headers: TICKETS_HEADERS as readonly string[] },
  { name: TAB_APPROVALS, headers: APPROVALS_HEADERS as readonly string[] },
  { name: TAB_AUDIT_LOG, headers: AUDIT_LOG_HEADERS as readonly string[] },
  { name: TAB_ROUTES, headers: ROUTES_HEADERS as readonly string[] },
] as const;
