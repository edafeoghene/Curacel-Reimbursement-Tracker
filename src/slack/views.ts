// Block-kit builders for the Phase 1.0/1.1 DMs.
//
// Stable action_ids:
//   - expense_approve
//   - expense_reject       (Phase 1.1)
//   - expense_mark_paid
//
// Modal callback_ids:
//   - expense_reject_modal (Phase 1.1)
//
// `tracking_id` is carried in the button's `value` field so handlers can
// resolve the ticket without parsing block IDs. For modals, the same id
// rides on `private_metadata` so the submit handler doesn't depend on a
// stale button value.
//
// Phase 1.2+ (clarify / delegate) buttons are intentionally NOT emitted yet.

import type { Ticket } from "../types.js";

export type Block = Record<string, unknown>;

export const ACTION_APPROVE = "expense_approve";
export const ACTION_REJECT = "expense_reject";
export const ACTION_MARK_PAID = "expense_mark_paid";

export const MODAL_REJECT_CALLBACK_ID = "expense_reject_modal";
export const REJECT_REASON_BLOCK_ID = "reject_reason_block";
export const REJECT_REASON_ACTION_ID = "reject_reason_input";

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
