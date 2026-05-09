import { describe, expect, it } from "vitest";
import {
  ACTION_APPROVE,
  ACTION_MARK_PAID,
  ACTION_REJECT,
  approverDmAfterApprove,
  approverDmAfterReject,
  approverDmBlocks,
  financialManagerDmAfterMarkPaid,
  financialManagerDmBlocks,
  manualReviewDmBlocks,
  MODAL_REJECT_CALLBACK_ID,
  REJECT_REASON_ACTION_ID,
  REJECT_REASON_BLOCK_ID,
  rejectionReasonModal,
} from "../../src/slack/views.js";
import type { Ticket } from "../../src/types.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    tracking_id: "EXP-2605-A7K2",
    created_at: "2026-05-09T10:00:00.000Z",
    source_message_ts: "1715250000.000100",
    source_channel_id: "C0EXPENSES",
    requester_user_id: "UREQ",
    requester_name: "Edafe",
    description: "Repaired the office laptop charging port",
    category: "repair",
    amount: 15000,
    currency: "NGN",
    receipt_file_id: "F123",
    receipt_file_url: "https://files.slack.com/private/F123",
    status: "SUBMITTED",
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "UAPP",
    payment_confirmation_file_id: null,
    updated_at: "2026-05-09T10:00:00.000Z",
    row_version: 1,
    ...overrides,
  };
}

function findActionsBlock(blocks: Array<Record<string, unknown>>) {
  return blocks.find((b) => b.type === "actions");
}

describe("approverDmBlocks", () => {
  it("returns blocks array, fallback text, and an Approve button with the tracking_id as value", () => {
    const ticket = makeTicket();
    const { blocks, fallbackText } = approverDmBlocks(ticket);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(2);
    expect(fallbackText).toMatch(ticket.tracking_id);
    expect(blocks[0]).toMatchObject({ type: "header" });

    const actions = findActionsBlock(blocks);
    expect(actions).toBeDefined();
    const elements = (actions as { elements: Array<Record<string, unknown>> }).elements;
    const btn = elements[0] as Record<string, unknown>;
    expect(btn.action_id).toBe(ACTION_APPROVE);
    expect(btn.value).toBe(ticket.tracking_id);
  });

  it("omits the receipt context block when no receipt URL is present", () => {
    const t = makeTicket({ receipt_file_url: "", receipt_file_id: "" });
    const { blocks } = approverDmBlocks(t);
    const ctx = blocks.find((b) => b.type === "context");
    expect(ctx).toBeUndefined();
  });

  it("includes a Reject button (danger style) alongside Approve", () => {
    const ticket = makeTicket();
    const { blocks } = approverDmBlocks(ticket);
    const actions = findActionsBlock(blocks) as {
      elements: Array<Record<string, unknown>>;
    };
    const action_ids = actions.elements.map((e) => e.action_id);
    expect(action_ids).toContain(ACTION_APPROVE);
    expect(action_ids).toContain(ACTION_REJECT);

    const rejectBtn = actions.elements.find(
      (e) => e.action_id === ACTION_REJECT,
    );
    expect(rejectBtn).toBeDefined();
    expect(rejectBtn?.style).toBe("danger");
    expect(rejectBtn?.value).toBe(ticket.tracking_id);
  });
});

describe("approverDmAfterReject", () => {
  it("drops actions, shows the rejected context and the reason", () => {
    const t = makeTicket();
    const reason = "Receipt unreadable; please re-upload.";
    const { blocks, fallbackText } = approverDmAfterReject(
      t,
      new Date("2026-05-09T14:32:00Z"),
      "Stephan",
      reason,
    );
    expect(findActionsBlock(blocks)).toBeUndefined();
    expect(fallbackText).toMatch(/Rejected/i);

    const allContexts = blocks.filter((b) => b.type === "context");
    const rejectedCtx = allContexts.find((c) => {
      const els = (c as { elements: Array<{ text?: string }> }).elements ?? [];
      return els.some((e) => typeof e.text === "string" && /Rejected/.test(e.text));
    });
    expect(rejectedCtx).toBeDefined();

    const hasReason = blocks.some(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        new RegExp(reason).test((b as { text: { text: string } }).text.text),
    );
    expect(hasReason).toBe(true);
  });
});

describe("rejectionReasonModal", () => {
  it("returns a modal view carrying tracking_id in private_metadata and a multiline reason input", () => {
    const trackingId = "EXP-2605-A7K2";
    const view = rejectionReasonModal(trackingId) as {
      type: string;
      callback_id: string;
      private_metadata: string;
      blocks: Array<Record<string, unknown>>;
      submit?: { type: string; text: string };
      close?: { type: string; text: string };
    };
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(MODAL_REJECT_CALLBACK_ID);
    expect(view.private_metadata).toBe(trackingId);
    expect(view.submit?.text).toBeTruthy();
    expect(view.close?.text).toBeTruthy();

    const inputBlock = view.blocks.find(
      (b) => b.type === "input" && b.block_id === REJECT_REASON_BLOCK_ID,
    ) as { element: Record<string, unknown> } | undefined;
    expect(inputBlock).toBeDefined();
    expect(inputBlock?.element.action_id).toBe(REJECT_REASON_ACTION_ID);
    expect(inputBlock?.element.type).toBe("plain_text_input");
    expect(inputBlock?.element.multiline).toBe(true);
  });

  it("renders the tracking_id in the modal copy so the user knows what they're rejecting", () => {
    const view = rejectionReasonModal("EXP-2605-XYZW") as {
      blocks: Array<Record<string, unknown>>;
    };
    const hasIdInCopy = view.blocks.some(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        /EXP-2605-XYZW/.test((b as { text: { text: string } }).text.text),
    );
    expect(hasIdInCopy).toBe(true);
  });
});

describe("approverDmAfterApprove", () => {
  it("removes the actions block and adds an approved context", () => {
    const t = makeTicket();
    const { blocks } = approverDmAfterApprove(
      t,
      new Date("2026-05-09T14:32:00Z"),
      "Stephan",
    );
    expect(findActionsBlock(blocks)).toBeUndefined();
    // There may be multiple context blocks (receipt + approved). Find one
    // whose text contains "Approved".
    const allContexts = blocks.filter((b) => b.type === "context");
    expect(allContexts.length).toBeGreaterThan(0);
    const approvedCtx = allContexts.find((c) => {
      const els = (c as { elements: Array<{ text?: string }> }).elements ?? [];
      return els.some((e) => typeof e.text === "string" && /Approved/.test(e.text));
    });
    expect(approvedCtx).toBeDefined();
  });
});

describe("financialManagerDmBlocks", () => {
  it("includes a Mark as Paid button with the tracking_id", () => {
    const t = makeTicket({ status: "APPROVED" });
    const { blocks } = financialManagerDmBlocks(t);
    const actions = findActionsBlock(blocks) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(actions).toBeDefined();
    const btn = actions.elements[0]!;
    expect(btn.action_id).toBe(ACTION_MARK_PAID);
    expect(btn.value).toBe(t.tracking_id);
  });
});

describe("financialManagerDmAfterMarkPaid", () => {
  it("drops the button and prompts for proof", () => {
    const t = makeTicket({ status: "AWAITING_PAYMENT" });
    const { blocks, fallbackText } = financialManagerDmAfterMarkPaid(t);
    expect(findActionsBlock(blocks)).toBeUndefined();
    expect(fallbackText).toMatch(/Awaiting payment/i);
    const hasPrompt = blocks.some(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        /proof of payment/i.test((b as { text: { text: string } }).text.text),
    );
    expect(hasPrompt).toBe(true);
  });
});

describe("manualReviewDmBlocks", () => {
  it("renders the reason and tracking id", () => {
    const t = makeTicket({ status: "MANUAL_REVIEW" });
    const { blocks, fallbackText } = manualReviewDmBlocks(t, "LLM call failed: timeout");
    expect(fallbackText).toMatch(t.tracking_id);
    const reasonBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        /timeout/i.test((b as { text: { text: string } }).text.text),
    );
    expect(reasonBlock).toBeDefined();
  });
});
