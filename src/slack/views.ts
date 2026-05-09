// Block-kit builders for the Phase 1.0/1.1/1.2/1.3 DMs.
//
// Stable action_ids:
//   - expense_approve
//   - expense_reject       (Phase 1.1)
//   - expense_clarify      (Phase 1.2)
//   - expense_delegate     (Phase 1.3)
//   - expense_mark_paid
//
// Modal callback_ids:
//   - expense_reject_modal   (Phase 1.1)
//   - expense_clarify_modal  (Phase 1.2)
//   - expense_delegate_modal (Phase 1.3)
//
// `tracking_id` is carried in the button's `value` field so handlers can
// resolve the ticket without parsing block IDs. For modals, the same id
// rides on `private_metadata` so the submit handler doesn't depend on a
// stale button value.

import type { Ticket } from "../types.js";

export type Block = Record<string, unknown>;

export const ACTION_APPROVE = "expense_approve";
export const ACTION_REJECT = "expense_reject";
export const ACTION_CLARIFY = "expense_clarify";
export const ACTION_DELEGATE = "expense_delegate";
export const ACTION_MARK_PAID = "expense_mark_paid";

export const MODAL_REJECT_CALLBACK_ID = "expense_reject_modal";
export const REJECT_REASON_BLOCK_ID = "reject_reason_block";
export const REJECT_REASON_ACTION_ID = "reject_reason_input";

export const MODAL_CLARIFY_CALLBACK_ID = "expense_clarify_modal";
export const CLARIFY_QUESTION_BLOCK_ID = "clarify_question_block";
export const CLARIFY_QUESTION_ACTION_ID = "clarify_question_input";

export const MODAL_DELEGATE_CALLBACK_ID = "expense_delegate_modal";
export const DELEGATE_USER_BLOCK_ID = "delegate_user_block";
export const DELEGATE_USER_ACTION_ID = "delegate_user_input";

// ---------- helpers ----------

function fmtAmount(amount: number, currency: string): string {
  // Conservative formatter — no thousands separators rolled in (we don't know
  // locale conventions for every currency). Display as "NGN 15,000".
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${currency} ${formatted}`;
}

function summaryFields(ticket: Ticket): Block {
  return {
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Tracking*\n\`${ticket.tracking_id}\`` },
      {
        type: "mrkdwn",
        text: `*Amount*\n${fmtAmount(ticket.amount, ticket.currency)}`,
      },
      { type: "mrkdwn", text: `*Category*\n${ticket.category}` },
      {
        type: "mrkdwn",
        text: `*Requester*\n<@${ticket.requester_user_id}>`,
      },
    ],
  };
}

function descriptionBlock(ticket: Ticket): Block {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*Description*\n${ticket.description}` },
  };
}

function receiptContextBlock(ticket: Ticket): Block | null {
  if (!ticket.receipt_file_url) return null;
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${ticket.receipt_file_url}|Receipt> · file id: \`${ticket.receipt_file_id || "n/a"}\``,
      },
    ],
  };
}

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text } };
}

function divider(): Block {
  return { type: "divider" };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function hhmm(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

// ---------- approver DM ----------

export function approverDmBlocks(ticket: Ticket): {
  blocks: Block[];
  fallbackText: string;
} {
  const blocks: Block[] = [
    header("Expense approval needed"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "actions",
    block_id: `approval_actions_${ticket.tracking_id}`,
    elements: [
      {
        type: "button",
        action_id: ACTION_APPROVE,
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value: ticket.tracking_id,
      },
      {
        type: "button",
        action_id: ACTION_CLARIFY,
        // Neutral button — no `style` field. Clarify is a question, not an
        // approval or a rejection.
        text: { type: "plain_text", text: "Clarify" },
        value: ticket.tracking_id,
      },
      {
        type: "button",
        action_id: ACTION_DELEGATE,
        // Neutral — handing off, not a decision.
        text: { type: "plain_text", text: "Delegate" },
        value: ticket.tracking_id,
      },
      {
        type: "button",
        action_id: ACTION_REJECT,
        style: "danger",
        text: { type: "plain_text", text: "Reject" },
        value: ticket.tracking_id,
      },
    ],
  });

  const fallbackText = `Expense approval needed: ${ticket.tracking_id} — ${fmtAmount(
    ticket.amount,
    ticket.currency,
  )}`;
  return { blocks, fallbackText };
}

export function approverDmAfterApprove(
  ticket: Ticket,
  approvedAt: Date,
  approverName: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Expense approval needed"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:white_check_mark: Approved · ${hhmm(approvedAt)} · ${approverName}`,
      },
    ],
  });

  const fallbackText = `Approved: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- financial manager DM ----------

function approvedByContext(approverUserIds: string[]): Block | null {
  if (approverUserIds.length === 0) return null;
  const mentions = approverUserIds.map((id) => `<@${id}>`).join(", ");
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:white_check_mark: Approved by: ${mentions}`,
      },
    ],
  };
}

export function financialManagerDmBlocks(
  ticket: Ticket,
  approverUserIds: string[] = [],
): {
  blocks: Block[];
  fallbackText: string;
} {
  const blocks: Block[] = [
    header("Ticket approved — ready for payment"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  const approvedBy = approvedByContext(approverUserIds);
  if (approvedBy) blocks.push(approvedBy);

  blocks.push(divider());
  blocks.push({
    type: "actions",
    block_id: `payment_actions_${ticket.tracking_id}`,
    elements: [
      {
        type: "button",
        action_id: ACTION_MARK_PAID,
        style: "primary",
        text: { type: "plain_text", text: "Mark as Paid" },
        value: ticket.tracking_id,
      },
    ],
  });

  const fallbackText = `Ready for payment: ${ticket.tracking_id} — ${fmtAmount(
    ticket.amount,
    ticket.currency,
  )}`;
  return { blocks, fallbackText };
}

export function financialManagerDmAfterMarkPaid(
  ticket: Ticket,
  approverUserIds: string[] = [],
): {
  blocks: Block[];
  fallbackText: string;
} {
  const blocks: Block[] = [
    header("Ticket approved — ready for payment"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  const approvedBy = approvedByContext(approverUserIds);
  if (approvedBy) blocks.push(approvedBy);

  blocks.push(divider());
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        ":moneybag: *Awaiting payment confirmation.* Reply to this DM with the proof of payment within 24h.",
    },
  });

  const fallbackText = `Awaiting payment proof for ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- approver DM: after reject (Phase 1.1) ----------

export function approverDmAfterReject(
  ticket: Ticket,
  rejectedAt: Date,
  approverName: string,
  reason: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Expense approval needed"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:x: Rejected · ${hhmm(rejectedAt)} · ${approverName}`,
      },
    ],
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Reason:* ${reason}` },
  });

  const fallbackText = `Rejected: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- DM: after cancel (Phase 1.6) ----------

/**
 * Generic "this ticket was cancelled" view used to replace any open
 * pending DM — approver DMs at any step, the FM Mark-as-Paid DM, etc.
 * Drops all buttons and surfaces who cancelled when.
 */
export function dmAfterCancel(
  ticket: Ticket,
  cancelledAt: Date,
  cancelledByUserId: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Expense cancelled"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:no_entry: Cancelled · ${hhmm(cancelledAt)} · by <@${cancelledByUserId}>`,
      },
    ],
  });

  const fallbackText = `Cancelled: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- approver DM: after clarify (Phase 1.2) ----------

export function approverDmAfterClarify(
  ticket: Ticket,
  askedAt: Date,
  approverName: string,
  question: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Expense approval needed"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:question: Awaiting clarification · ${hhmm(askedAt)} · ${approverName}`,
      },
    ],
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Question:* ${question}` },
  });

  const fallbackText = `Awaiting clarification: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- clarification question modal (Phase 1.2) ----------

/**
 * Modal opened when an approver clicks "Clarify". Submission carries the
 * question in
 * `view.state.values[CLARIFY_QUESTION_BLOCK_ID][CLARIFY_QUESTION_ACTION_ID].value`,
 * and the tracking_id rides on `view.private_metadata`.
 */
export function clarificationQuestionModal(trackingId: string): Block {
  return {
    type: "modal",
    callback_id: MODAL_CLARIFY_CALLBACK_ID,
    private_metadata: trackingId,
    title: { type: "plain_text", text: "Ask the requester" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Asking about \`${trackingId}\`. The requester will see this question in the channel thread. The financial manager can resume the approval with \`/expense-resume ${trackingId}\` once it's answered.`,
        },
      },
      {
        type: "input",
        block_id: CLARIFY_QUESTION_BLOCK_ID,
        label: { type: "plain_text", text: "Question for the requester" },
        element: {
          type: "plain_text_input",
          action_id: CLARIFY_QUESTION_ACTION_ID,
          multiline: true,
          max_length: 500,
          placeholder: {
            type: "plain_text",
            text: "e.g. Who is this laptop for, and is it a replacement?",
          },
        },
      },
    ],
  };
}

// ---------- approver DM: after delegate (Phase 1.3) ----------

export function approverDmAfterDelegate(
  ticket: Ticket,
  delegatedAt: Date,
  fromName: string,
  toUserId: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Expense approval needed"),
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  blocks.push(divider());
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:busts_in_silhouette: Delegated to <@${toUserId}> · ${hhmm(delegatedAt)} · by ${fromName}`,
      },
    ],
  });

  const fallbackText = `Delegated: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- delegate user-picker modal (Phase 1.3) ----------

/**
 * Modal opened when an approver clicks "Delegate". Submission carries the
 * chosen user id in
 * `view.state.values[DELEGATE_USER_BLOCK_ID][DELEGATE_USER_ACTION_ID].selected_user`,
 * and the tracking_id rides on `view.private_metadata`.
 */
export function delegateUserPickerModal(trackingId: string): Block {
  return {
    type: "modal",
    callback_id: MODAL_DELEGATE_CALLBACK_ID,
    private_metadata: trackingId,
    title: { type: "plain_text", text: "Delegate approval" },
    submit: { type: "plain_text", text: "Delegate" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Delegating \`${trackingId}\`. The new approver will receive a fresh DM and become the only person who can act on this step.`,
        },
      },
      {
        type: "input",
        block_id: DELEGATE_USER_BLOCK_ID,
        label: { type: "plain_text", text: "Delegate to" },
        element: {
          type: "users_select",
          action_id: DELEGATE_USER_ACTION_ID,
          placeholder: { type: "plain_text", text: "Pick a user" },
        },
      },
    ],
  };
}

// ---------- FM clarification-hint DM (Phase 1.2) ----------

/**
 * Sent to the financial manager when an approver requests clarification on a
 * ticket. The FM doesn't action the question — they just need to see the
 * resume command once the requester answers.
 */
export function financialManagerClarifyHintBlocks(
  ticket: Ticket,
  approverUserId: string,
  question: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Clarification requested"),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<@${approverUserId}> asked the requester for clarification on \`${ticket.tracking_id}\`.`,
      },
    },
    summaryFields(ticket),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Question:* ${question}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `When the requester answers in the thread, resume with \`/expense-resume ${ticket.tracking_id}\`.`,
        },
      ],
    },
  ];

  const fallbackText = `Clarification requested on ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}

// ---------- reject reason modal (Phase 1.1) ----------

/**
 * Modal opened when an approver clicks "Reject". Submission carries the
 * reason in `view.state.values[REJECT_REASON_BLOCK_ID][REJECT_REASON_ACTION_ID].value`,
 * and the tracking_id rides on `view.private_metadata` (more reliable than
 * a button value because the modal can be opened then submitted minutes
 * later, by which time the original button payload may be irrelevant).
 */
export function rejectionReasonModal(trackingId: string): Block {
  return {
    type: "modal",
    callback_id: MODAL_REJECT_CALLBACK_ID,
    private_metadata: trackingId,
    title: { type: "plain_text", text: "Reject expense" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Rejecting \`${trackingId}\`. The requester will see this reason in the channel thread.`,
        },
      },
      {
        type: "input",
        block_id: REJECT_REASON_BLOCK_ID,
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: REJECT_REASON_ACTION_ID,
          multiline: true,
          max_length: 500,
          placeholder: {
            type: "plain_text",
            text: "e.g. Receipt unreadable — please re-upload.",
          },
        },
      },
    ],
  };
}

// ---------- manual review DM ----------

export function manualReviewDmBlocks(
  ticket: Ticket,
  reason: string,
): { blocks: Block[]; fallbackText: string } {
  const blocks: Block[] = [
    header("Manual review needed"),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Ticket \`${ticket.tracking_id}\` requires manual review.\n*Reason:* ${reason}`,
      },
    },
    summaryFields(ticket),
    descriptionBlock(ticket),
  ];
  const ctx = receiptContextBlock(ticket);
  if (ctx) blocks.push(ctx);

  const fallbackText = `Manual review needed: ${ticket.tracking_id}`;
  return { blocks, fallbackText };
}
