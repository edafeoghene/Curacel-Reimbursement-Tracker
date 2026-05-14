// Shared type contract. Bot and frontend both import from here.
// If a type doesn't fit a sheet column or a state transition, it doesn't go here.

// ---------- Sentinels ----------

/**
 * Sentinel `step_number` for the financial-manager Mark-as-Paid approval row.
 * Phase 1.0 needed somewhere to store the FM DM coords (channel + ts) so the
 * file_share watcher could match the proof back to a ticket; we couldn't add
 * fields to the Ticket type without a sheet schema change, so an approval
 * row at step_number = 99 holds the coords. NEXT.md follow-up B tracks the
 * proper fix (move to dedicated Ticket fields).
 */
export const PAYMENT_STEP_SENTINEL = 99;

// ---------- States & decisions ----------

export const TICKET_STATUSES = [
  "SUBMITTED",
  "AWAITING_APPROVAL",
  "NEEDS_CLARIFICATION",
  "APPROVED",
  "AWAITING_PAYMENT",
  "PAID",
  "REJECTED",
  "CANCELLED",
  "MANUAL_REVIEW",
] as const;
export type Status = (typeof TICKET_STATUSES)[number];

export const TERMINAL_STATUSES = ["PAID", "REJECTED", "CANCELLED"] as const satisfies readonly Status[];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const TERMINAL_SET: ReadonlySet<Status> = new Set<Status>(TERMINAL_STATUSES);

/**
 * True iff the status represents a terminal state (PAID / REJECTED /
 * CANCELLED). Single source of truth — every other module imports this
 * helper instead of redefining its own set.
 */
export function isTerminalStatus(status: Status): boolean {
  return TERMINAL_SET.has(status);
}

export const APPROVAL_DECISIONS = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CLARIFICATION_REQUESTED",
  "DELEGATED",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ---------- Sheet row shapes ----------
// Field order here MUST match the column order written by the bootstrap script.

export interface Ticket {
  tracking_id: string;
  created_at: string; // ISO 8601 UTC
  source_message_ts: string;
  source_channel_id: string;
  requester_user_id: string;
  requester_name: string;
  description: string;
  category: string;
  amount: number;
  currency: string; // ISO 4217
  receipt_file_id: string;
  receipt_file_url: string;
  status: Status;
  route_id: string;
  current_step: number; // 1-indexed
  current_approver_user_id: string;
  payment_confirmation_file_id: string | null;
  updated_at: string; // ISO 8601 UTC
  row_version: number; // optimistic concurrency token
}

export interface Approval {
  approval_id: string; // UUID
  tracking_id: string;
  step_number: number;
  approver_user_id: string; // current assignee (changes on delegate)
  approver_name: string;
  decision: ApprovalDecision;
  decided_at: string | null; // ISO until decided
  comment: string;
  delegated_to_user_id: string | null;
  dm_channel_id: string;
  message_ts: string;
}

export interface AuditLogEntry {
  log_id: string; // UUID
  tracking_id: string;
  timestamp: string; // ISO 8601 UTC
  actor_user_id: string;
  event_type: string;
  details_json: string; // stringified JSON of the event payload
}

// Employee directory row — drives team-lead approval routing. Headers in the
// sheet are human-friendly ("Employee Name", "Team Slack Channel" etc.) and
// some carry trailing whitespace; the loader normalizes both.
export interface Employee {
  employee_name: string;
  team_lead_name: string;
  team: string;
  employee_slack_id: string; // U…
  team_lead_slack_id: string; // U… (may be empty / invalid — checked downstream)
  team_channel_id: string; // C… or G… (may be empty / invalid — checked downstream)
}

// ---------- State machine ----------

export type StateEvent =
  | { type: "CLASSIFIED"; confidence: number }
  | { type: "FIRST_DM_SENT" }
  // is_final_step: caller (slack handler) computes whether this approval was
  // the last step in the route chain. Pure state machine cannot know the
  // chain length on its own, and a side-channel arg would muddy the API.
  | { type: "APPROVE"; step: number; approver_user_id: string; is_final_step: boolean }
  | { type: "REJECT"; step: number; approver_user_id: string; reason: string }
  | { type: "CLARIFY"; step: number; approver_user_id: string; question: string }
  | { type: "RESUME_AFTER_CLARIFY" }
  | { type: "MARK_AS_PAID" }
  | { type: "PAYMENT_CONFIRMED"; file_id: string }
  | { type: "CANCEL"; actor_user_id: string }
  // FM clicked "Approve & Pay" on a manual-review DM. Legal only from
  // MANUAL_REVIEW. Transitions straight to APPROVED with the standard
  // DM_FINANCIAL_MANAGER_FOR_PAYMENT side effect — from there the existing
  // Mark-as-Paid flow takes over.
  | { type: "FM_APPROVE_FROM_MANUAL_REVIEW"; fm_user_id: string }
  // Recovery escalation. Legal from any non-terminal status. Used when an
  // out-of-band failure (DM rejected, route deleted mid-flight, approval row
  // write failed, etc.) leaves a ticket in a state that can't proceed via the
  // normal happy path. PLAN.md §4 #10: every status mutation must go through
  // transition() — this event keeps recovery paths honest with the rule.
  | { type: "ESCALATE_TO_MANUAL_REVIEW"; reason: string };

export type SideEffect =
  // Non-final APPROVE: advance the chain. Caller resolves the next approver
  // from the route (which it already loaded to compute is_final_step) and
  // updates ticket.current_step / current_approver_user_id accordingly.
  | { type: "ADVANCE_TO_STEP"; step_number: number }
  // RESUME_AFTER_CLARIFY: re-DM the same approver at the same step. Caller
  // reads ticket.current_step / current_approver_user_id directly.
  | { type: "RE_DM_CURRENT_APPROVER" }
  | { type: "DM_FINANCIAL_MANAGER_FOR_PAYMENT" }
  | { type: "DM_FINANCIAL_MANAGER_MANUAL_REVIEW"; reason: string }
  | { type: "DM_FINANCIAL_MANAGER_CLARIFICATION"; requester_user_id: string }
  | { type: "POST_REJECTION_TO_THREAD"; reason: string; rejected_by: string }
  | { type: "POST_CLARIFICATION_TO_THREAD"; question: string; asked_by: string }
  | { type: "POST_PAYMENT_PROOF_TO_THREAD"; file_id: string }
  | { type: "POST_CANCELLATION_TO_THREAD"; cancelled_by: string }
  | { type: "REQUEST_PAYMENT_PROOF_DM" };

export type TransitionResult =
  | { ok: true; next: Status; sideEffects: SideEffect[] }
  | { ok: false; error: string };

// ---------- LLM classifier ----------

export interface ClassifierItem {
  description: string;
  category: string;
  amount: number;
  currency: string; // ISO 4217
  vendor: string;
  date: string; // ISO date (YYYY-MM-DD)
}

export interface ClassifierResult {
  is_expense: boolean;
  confidence: number; // 0..1
  items: ClassifierItem[];
  notes: string;
}

// Image input to the classifier — file already downloaded and decoded
export interface ClassifierImage {
  mime: string; // e.g. "image/png"
  base64: string; // raw base64 (no data: prefix)
}

export interface ClassifyInput {
  text: string;
  images: ClassifierImage[];
}

// ---------- Sheet schema (column order + tab names) ----------
// Both bot reads/writes and the frontend read layer reference these. The
// `as const satisfies readonly (keyof X)[]` clauses are compile-time guards:
// if a Ticket / Approval / AuditLogEntry / Employee field is renamed or
// added, the corresponding header array fails to typecheck.

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

// EMPLOYEES_HEADERS captures the *order* of columns in the "Employee data"
// tab. The actual header cells in the sheet use display-friendly names
// ("Employee Name", "Team Slack Channel" — some with trailing whitespace),
// so this tab is intentionally NOT included in ALL_TABS and is not managed
// by the bootstrap script. The loader matches by position, not by name.
export const EMPLOYEES_HEADERS = [
  "employee_name",
  "team_lead_name",
  "team",
  "employee_slack_id",
  "team_lead_slack_id",
  "team_channel_id",
] as const satisfies readonly (keyof Employee)[];

export const TAB_TICKETS = "tickets";
export const TAB_APPROVALS = "approvals";
export const TAB_AUDIT_LOG = "audit_log";
export const TAB_EMPLOYEES = "Employee data";

export const ALL_TABS = [
  { name: TAB_TICKETS, headers: TICKETS_HEADERS as readonly string[] },
  { name: TAB_APPROVALS, headers: APPROVALS_HEADERS as readonly string[] },
  { name: TAB_AUDIT_LOG, headers: AUDIT_LOG_HEADERS as readonly string[] },
] as const;

// ---------- Audit event types (kept as string constants for grep-ability) ----------

export const AUDIT_EVENTS = {
  TICKET_CREATED: "TICKET_CREATED",
  LLM_CLASSIFIED: "LLM_CLASSIFIED",
  LLM_FAILED: "LLM_FAILED",
  STATE_TRANSITION: "STATE_TRANSITION",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  CLARIFICATION_RESUMED: "CLARIFICATION_RESUMED",
  DELEGATED: "DELEGATED",
  PAYMENT_MARKED: "PAYMENT_MARKED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  CANCELLED: "CANCELLED",
  AUTHORIZATION_REJECTED: "AUTHORIZATION_REJECTED",
  ROUTES_REFRESHED: "ROUTES_REFRESHED",
  RECEIPT_PARSED: "RECEIPT_PARSED",
  // Umbrella reason-bearing entry for tickets that begin life in
  // MANUAL_REVIEW (low confidence, no matching route, no approvers, etc.).
  // Distinct from LLM_FAILED which is reserved for actual classifier
  // failures so audit-log greps stay meaningful.
  MANUAL_REVIEW_OPENED: "MANUAL_REVIEW_OPENED",
} as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
