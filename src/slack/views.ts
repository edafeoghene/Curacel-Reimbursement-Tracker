// Block-kit builders for the Phase 1.0 DMs.
//
// Stable action_ids:
//   - expense_approve
//   - expense_mark_paid
//
// `tracking_id` is carried in the button's `value` field so handlers can
// resolve the ticket without parsing block IDs.
//
// Phase 1.1+ (reject / clarify / delegate) buttons are intentionally NOT
// emitted here yet.

import type { Ticket } from "../types.js";

export type Block = Record<string, unknown>;

export const ACTION_APPROVE = "expense_approve";
export const ACTION_MARK_PAID = "expense_mark_paid";

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

export function financialManagerDmBlocks(ticket: Ticket): {
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

export function financialManagerDmAfterMarkPaid(ticket: Ticket): {
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
