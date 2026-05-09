// Shared type contract. Every module in this codebase imports from here.
// If a type doesn't fit a sheet column or a state transition, it doesn't go here.

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

// Routes sheet shape (raw row before parsing)
export interface RouteRow {
  route_id: string;
  currency: string;
  min_amount: number;
  max_amount: number | null; // null = no upper bound
  category_filter: string; // CSV
  approvers_csv: string; // CSV of Slack user IDs in order
}

// Parsed/normalized route used by routing logic
export interface Route {
  route_id: string;
  currency: string;
  min_amount: number;
  max_amount: number | null;
  category_filter: string[]; // empty array = all categories
  approvers: string[]; // ordered chain
}

// ---------- State machine ----------

export type StateEvent =
  | { type: "CLASSIFIED"; confidence: number }
  | { type: "FIRST_DM_SENT" }
  | { type: "APPROVE"; step: number; approver_user_id: string }
  | { type: "REJECT"; step: number; approver_user_id: string; reason: string }
  | { type: "CLARIFY"; step: number; approver_user_id: string; question: string }
  | { type: "RESUME_AFTER_CLARIFY" }
  | { type: "MARK_AS_PAID" }
  | { type: "PAYMENT_CONFIRMED"; file_id: string }
  | { type: "CANCEL"; actor_user_id: string };

export type SideEffect =
  | { type: "DM_NEXT_APPROVER"; approver_user_id: string; step_number: number }
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
} as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
