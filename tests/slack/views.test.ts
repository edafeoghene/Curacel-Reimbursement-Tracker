import { describe, expect, it } from "vitest";
import {
  ACTION_APPROVE,
  ACTION_CLARIFY,
  ACTION_DELEGATE,
  ACTION_MARK_PAID,
  ACTION_REJECT,
  approverDmAfterApprove,
  approverDmAfterClarify,
  approverDmAfterDelegate,
  approverDmAfterReject,
  approverDmBlocks,
  dmAfterCancel,
  statusBlocks,
  CLARIFY_QUESTION_ACTION_ID,
  CLARIFY_QUESTION_BLOCK_ID,
  clarificationQuestionModal,
  DELEGATE_USER_ACTION_ID,
  DELEGATE_USER_BLOCK_ID,
  delegateUserPickerModal,
  financialManagerClarifyHintBlocks,
  financialManagerDmAfterMarkPaid,
  financialManagerDmBlocks,
  manualReviewDmBlocks,
  MODAL_CLARIFY_CALLBACK_ID,
  MODAL_DELEGATE_CALLBACK_ID,
  MODAL_REJECT_CALLBACK_ID,
  REJECT_REASON_ACTION_ID,
  REJECT_REASON_BLOCK_ID,
  rejectionReasonModal,
} from "../../src/slack/views.js";
import type { Approval, Ticket } from "@curacel/shared";

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

  it("includes a neutral Clarify button alongside Approve and Reject", () => {
    const ticket = makeTicket();
    const { blocks } = approverDmBlocks(ticket);
    const actions = findActionsBlock(blocks) as {
      elements: Array<Record<string, unknown>>;
    };
    const clarifyBtn = actions.elements.find(
      (e) => e.action_id === ACTION_CLARIFY,
    );
    expect(clarifyBtn).toBeDefined();
    // Neutral — no style field.
    expect(clarifyBtn?.style).toBeUndefined();
    expect(clarifyBtn?.value).toBe(ticket.tracking_id);
  });

  it("includes a neutral Delegate button", () => {
    const ticket = makeTicket();
    const { blocks } = approverDmBlocks(ticket);
    const actions = findActionsBlock(blocks) as {
      elements: Array<Record<string, unknown>>;
    };
    const delegateBtn = actions.elements.find(
      (e) => e.action_id === ACTION_DELEGATE,
    );
    expect(delegateBtn).toBeDefined();
    expect(delegateBtn?.style).toBeUndefined();
    expect(delegateBtn?.value).toBe(ticket.tracking_id);
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

describe("approverDmAfterClarify", () => {
  it("drops actions, shows the awaiting-clarification context and the question", () => {
    const t = makeTicket();
    const question = "Who is this laptop for?";
    const { blocks, fallbackText } = approverDmAfterClarify(
      t,
      new Date("2026-05-09T14:32:00Z"),
      "Stephan",
      question,
    );
    expect(findActionsBlock(blocks)).toBeUndefined();
    expect(fallbackText).toMatch(/clarification/i);

    const allContexts = blocks.filter((b) => b.type === "context");
    const awaitingCtx = allContexts.find((c) => {
      const els = (c as { elements: Array<{ text?: string }> }).elements ?? [];
      return els.some(
        (e) =>
          typeof e.text === "string" && /Awaiting clarification/.test(e.text),
      );
    });
    expect(awaitingCtx).toBeDefined();

    const hasQuestion = blocks.some(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        new RegExp(question).test((b as { text: { text: string } }).text.text),
    );
    expect(hasQuestion).toBe(true);
  });
});

describe("clarificationQuestionModal", () => {
  it("returns a modal view carrying tracking_id in private_metadata and a multiline question input", () => {
    const trackingId = "EXP-2605-A7K2";
    const view = clarificationQuestionModal(trackingId) as {
      type: string;
      callback_id: string;
      private_metadata: string;
      blocks: Array<Record<string, unknown>>;
      submit?: { type: string; text: string };
      close?: { type: string; text: string };
    };
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(MODAL_CLARIFY_CALLBACK_ID);
    expect(view.private_metadata).toBe(trackingId);
    expect(view.submit?.text).toBeTruthy();
    expect(view.close?.text).toBeTruthy();

    const inputBlock = view.blocks.find(
      (b) => b.type === "input" && b.block_id === CLARIFY_QUESTION_BLOCK_ID,
    ) as { element: Record<string, unknown> } | undefined;
    expect(inputBlock).toBeDefined();
    expect(inputBlock?.element.action_id).toBe(CLARIFY_QUESTION_ACTION_ID);
    expect(inputBlock?.element.type).toBe("plain_text_input");
    expect(inputBlock?.element.multiline).toBe(true);
  });

  it("references the /expense-resume command in the modal copy so the approver knows how it's resumed", () => {
    const view = clarificationQuestionModal("EXP-2605-XYZW") as {
      blocks: Array<Record<string, unknown>>;
    };
    const hasResumeHint = view.blocks.some(
      (b) =>
        b.type === "section" &&
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        /\/expense-resume/.test((b as { text: { text: string } }).text.text),
    );
    expect(hasResumeHint).toBe(true);
  });
});

describe("financialManagerClarifyHintBlocks", () => {
  it("includes the asking approver, the question, and the resume command", () => {
    const t = makeTicket({ status: "NEEDS_CLARIFICATION" });
    const { blocks, fallbackText } = financialManagerClarifyHintBlocks(
      t,
      "U_PATRICK",
      "Who is this for?",
    );
    expect(fallbackText).toMatch(t.tracking_id);
    const concatText = blocks
      .map((b) => JSON.stringify(b))
      .join("\n");
    expect(concatText).toContain("<@U_PATRICK>");
    expect(concatText).toContain("Who is this for?");
    expect(concatText).toContain(`/expense-resume ${t.tracking_id}`);
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

  it("renders no Approved-by line when the approvers list is empty", () => {
    const t = makeTicket({ status: "APPROVED" });
    const { blocks } = financialManagerDmBlocks(t, []);
    const hasApprovedBy = blocks.some(
      (b) =>
        b.type === "context" &&
        Array.isArray((b as { elements?: unknown[] }).elements) &&
        ((b as { elements: Array<{ text?: string }> }).elements[0]?.text ?? "")
          .toString()
          .includes("Approved by"),
    );
    expect(hasApprovedBy).toBe(false);
  });

  it("tags every approver passed in, in order", () => {
    const t = makeTicket({ status: "APPROVED" });
    const { blocks } = financialManagerDmBlocks(t, ["U_PATRICK", "U_TINUS"]);
    const ctx = blocks.find(
      (b) =>
        b.type === "context" &&
        Array.isArray((b as { elements?: unknown[] }).elements) &&
        ((b as { elements: Array<{ text?: string }> }).elements[0]?.text ?? "")
          .toString()
          .includes("Approved by"),
    ) as { elements: Array<{ text: string }> } | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.elements[0]!.text).toContain("<@U_PATRICK>");
    expect(ctx!.elements[0]!.text).toContain("<@U_TINUS>");
    // ordering preserved (first listed appears first in the rendered string)
    expect(ctx!.elements[0]!.text.indexOf("<@U_PATRICK>")).toBeLessThan(
      ctx!.elements[0]!.text.indexOf("<@U_TINUS>"),
    );
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

  it("preserves the Approved-by line after Mark as Paid", () => {
    const t = makeTicket({ status: "AWAITING_PAYMENT" });
    const { blocks } = financialManagerDmAfterMarkPaid(t, ["U_PATRICK"]);
    const ctx = blocks.find(
      (b) =>
        b.type === "context" &&
        Array.isArray((b as { elements?: unknown[] }).elements) &&
        ((b as { elements: Array<{ text?: string }> }).elements[0]?.text ?? "")
          .toString()
          .includes("Approved by"),
    ) as { elements: Array<{ text: string }> } | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.elements[0]!.text).toContain("<@U_PATRICK>");
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

describe("approverDmAfterDelegate", () => {
  it("drops actions and shows the delegated context with both names", () => {
    const t = makeTicket();
    const { blocks, fallbackText } = approverDmAfterDelegate(
      t,
      new Date("2026-05-09T14:32:00Z"),
      "Stephan",
      "U_PATRICK",
    );
    expect(findActionsBlock(blocks)).toBeUndefined();
    expect(fallbackText).toMatch(/Delegated/);
    const ctx = blocks
      .filter((b) => b.type === "context")
      .find((c) => {
        const els =
          (c as { elements: Array<{ text?: string }> }).elements ?? [];
        return els.some(
          (e) => typeof e.text === "string" && /Delegated/.test(e.text),
        );
      }) as { elements: Array<{ text: string }> } | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.elements[0]!.text).toContain("<@U_PATRICK>");
    expect(ctx!.elements[0]!.text).toContain("Stephan");
  });
});

describe("dmAfterCancel", () => {
  it("drops actions and shows a cancelled context line tagging the canceller", () => {
    const t = makeTicket();
    const { blocks, fallbackText } = dmAfterCancel(
      t,
      new Date("2026-05-09T14:32:00Z"),
      "U_REQUESTER",
    );
    expect(findActionsBlock(blocks)).toBeUndefined();
    expect(fallbackText).toMatch(/Cancelled/);
    const ctx = blocks
      .filter((b) => b.type === "context")
      .find((c) => {
        const els =
          (c as { elements: Array<{ text?: string }> }).elements ?? [];
        return els.some(
          (e) => typeof e.text === "string" && /Cancelled/.test(e.text),
        );
      }) as { elements: Array<{ text: string }> } | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.elements[0]!.text).toContain("<@U_REQUESTER>");
  });
});

describe("delegateUserPickerModal", () => {
  it("returns a modal view with a users_select element and the tracking_id in private_metadata", () => {
    const trackingId = "EXP-2605-A7K2";
    const view = delegateUserPickerModal(trackingId) as {
      type: string;
      callback_id: string;
      private_metadata: string;
      blocks: Array<Record<string, unknown>>;
      submit?: { type: string; text: string };
      close?: { type: string; text: string };
    };
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(MODAL_DELEGATE_CALLBACK_ID);
    expect(view.private_metadata).toBe(trackingId);
    expect(view.submit?.text).toBeTruthy();

    const inputBlock = view.blocks.find(
      (b) => b.type === "input" && b.block_id === DELEGATE_USER_BLOCK_ID,
    ) as { element: Record<string, unknown> } | undefined;
    expect(inputBlock).toBeDefined();
    expect(inputBlock?.element.action_id).toBe(DELEGATE_USER_ACTION_ID);
    expect(inputBlock?.element.type).toBe("users_select");
  });
});

// ---------- statusBlocks (Phase 1.8 — /expense-status slash command) ----------

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "11111111-1111-1111-1111-111111111111",
    tracking_id: "EXP-2605-A7K2",
    step_number: 1,
    approver_user_id: "UAPP1",
    approver_name: "Kunle",
    decision: "PENDING",
    decided_at: null,
    comment: "",
    delegated_to_user_id: null,
    dm_channel_id: "D1",
    message_ts: "1715250100.000200",
    ...overrides,
  };
}

const FROZEN_NOW = new Date("2026-05-09T13:00:00.000Z");

function collectMrkdwn(blocks: Array<Record<string, unknown>>): string {
  // Flatten every mrkdwn text we render into a single string so individual
  // assertions can use substring matches without depending on block ordering.
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "mrkdwn" && typeof o.text === "string") out.push(o.text);
    for (const val of Object.values(o)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") walk(val);
    }
  };
  blocks.forEach(walk);
  return out.join("\n");
}

describe("statusBlocks", () => {
  it("renders a header + summary fields + 'Currently with' for an AWAITING_APPROVAL ticket with no decisions yet", () => {
    const ticket = makeTicket({
      status: "AWAITING_APPROVAL",
      current_step: 1,
      current_approver_user_id: "UAPP1",
    });
    const approvals = [makeApproval({ decision: "PENDING" })];

    const { blocks, fallbackText } = statusBlocks(ticket, approvals, {
      now: FROZEN_NOW,
    });

    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(fallbackText).toContain("EXP-2605-A7K2");
    expect(fallbackText).toContain("AWAITING_APPROVAL");

    const text = collectMrkdwn(blocks);
    expect(text).toContain("AWAITING_APPROVAL");
    expect(text).toContain("step 1");
    // current_approver_user_id rendered as a Slack mention
    expect(text).toContain("<@UAPP1>");
    expect(text).toContain("EXP-2605-A7K2");
    // Submitted line shows both absolute UTC and relative "ago"
    expect(text).toMatch(/Submitted/);
    expect(text).toMatch(/ago/);
  });

  it("shows step-1 APPROVED in the timeline and routes 'Currently with' to step 2", () => {
    const ticket = makeTicket({
      status: "AWAITING_APPROVAL",
      current_step: 2,
      current_approver_user_id: "UAPP2",
    });
    const approvals = [
      makeApproval({
        step_number: 1,
        approver_user_id: "UAPP1",
        approver_name: "Kunle",
        decision: "APPROVED",
        decided_at: "2026-05-09T11:00:00.000Z",
      }),
      makeApproval({
        step_number: 2,
        approver_user_id: "UAPP2",
        approver_name: "Tola",
        decision: "PENDING",
      }),
    ];

    const { blocks } = statusBlocks(ticket, approvals, { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);

    expect(text).toContain("<@UAPP2>"); // currently-with line
    expect(text).toContain(":white_check_mark:"); // step-1 approved
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
    expect(text).toContain(":hourglass_flowing_sand:"); // step-2 pending
  });

  it("suppresses 'Currently with' on terminal statuses (PAID / REJECTED / CANCELLED)", () => {
    // APPROVED is non-terminal: the FM holds the ball for Mark-as-Paid, so
    // 'Currently with: @FM' is still informative there. See isTerminalStatus.
    for (const status of ["PAID", "REJECTED", "CANCELLED"] as const) {
      const ticket = makeTicket({ status });
      const { blocks } = statusBlocks(ticket, [], { now: FROZEN_NOW });
      const text = collectMrkdwn(blocks);
      expect(text).not.toMatch(/Currently with/i);
    }
  });

  it("renders a REJECTED row with reason from the comment field", () => {
    const ticket = makeTicket({ status: "REJECTED" });
    const approvals = [
      makeApproval({
        decision: "REJECTED",
        decided_at: "2026-05-09T11:30:00.000Z",
        comment: "Receipt unreadable — please re-upload.",
      }),
    ];

    const { blocks } = statusBlocks(ticket, approvals, { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);

    expect(text).toContain(":x:");
    expect(text).toContain("Receipt unreadable");
  });

  it("renders a CLARIFICATION_REQUESTED row with the question from the comment field", () => {
    const ticket = makeTicket({ status: "NEEDS_CLARIFICATION" });
    const approvals = [
      makeApproval({
        decision: "CLARIFICATION_REQUESTED",
        decided_at: "2026-05-09T11:15:00.000Z",
        comment: "Who is this laptop for?",
      }),
    ];

    const { blocks } = statusBlocks(ticket, approvals, { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);

    expect(text).toContain(":question:");
    expect(text).toContain("Who is this laptop for?");
  });

  it("renders a DELEGATED row with arrow notation showing the new approver", () => {
    const ticket = makeTicket({ status: "AWAITING_APPROVAL" });
    const approvals = [
      makeApproval({
        decision: "DELEGATED",
        decided_at: "2026-05-09T11:45:00.000Z",
        delegated_to_user_id: "UAPP_NEW",
      }),
    ];

    const { blocks } = statusBlocks(ticket, approvals, { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);

    expect(text).toContain(":busts_in_silhouette:");
    expect(text).toContain("<@UAPP_NEW>");
  });

  it("shows a triage note instead of an empty timeline when the ticket is in MANUAL_REVIEW", () => {
    const ticket = makeTicket({
      status: "MANUAL_REVIEW",
      current_step: 0,
      current_approver_user_id: "",
    });

    const { blocks } = statusBlocks(ticket, [], { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);

    expect(text).toContain("MANUAL_REVIEW");
    expect(text).toMatch(/triage|manual review/i);
    expect(text).not.toMatch(/Currently with/i);
  });

  it("includes the receipt context block when receipt_file_url is set, omits it otherwise", () => {
    const withReceipt = statusBlocks(makeTicket(), [], { now: FROZEN_NOW }).blocks;
    expect(withReceipt.find((b) => b.type === "context")).toBeDefined();

    const withoutReceipt = statusBlocks(
      makeTicket({ receipt_file_url: "", receipt_file_id: "" }),
      [],
      { now: FROZEN_NOW },
    ).blocks;
    // No receipt + no other context blocks expected from this builder
    expect(withoutReceipt.find((b) => b.type === "context")).toBeUndefined();
  });

  it("orders the timeline by step_number ascending", () => {
    const ticket = makeTicket({ status: "APPROVED" });
    // Pass approvals out of order to make sure the renderer sorts them.
    const approvals = [
      makeApproval({
        step_number: 2,
        decision: "APPROVED",
        decided_at: "2026-05-09T12:00:00.000Z",
        approver_user_id: "UAPP2",
      }),
      makeApproval({
        step_number: 1,
        decision: "APPROVED",
        decided_at: "2026-05-09T11:00:00.000Z",
        approver_user_id: "UAPP1",
      }),
    ];

    const { blocks } = statusBlocks(ticket, approvals, { now: FROZEN_NOW });
    const text = collectMrkdwn(blocks);
    const idx1 = text.indexOf("Step 1");
    const idx2 = text.indexOf("Step 2");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });
});
