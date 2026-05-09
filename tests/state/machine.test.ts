import { describe, expect, it } from "vitest";
import { transition } from "../../src/state/machine.js";
import type { Ticket, Status, StateEvent } from "../../src/types.js";

// Build a ticket fixture in any status with sensible defaults. Tests override
// only the fields that matter for the case under test.
function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    tracking_id: "EXP-2605-A7K2",
    created_at: "2026-05-09T10:00:00.000Z",
    source_message_ts: "1715251200.000100",
    source_channel_id: "C_EXPENSES",
    requester_user_id: "U_REQUESTER",
    requester_name: "Edafe",
    description: "Office laptop charging port repair",
    category: "equipment",
    amount: 15000,
    currency: "NGN",
    receipt_file_id: "F_001",
    receipt_file_url: "https://files.slack.com/...",
    status: "SUBMITTED",
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "U_STEPHAN",
    payment_confirmation_file_id: null,
    updated_at: "2026-05-09T10:00:00.000Z",
    row_version: 1,
    ...overrides,
  };
}

describe("transition: CLASSIFIED", () => {
  it("high-confidence stays in SUBMITTED with no side effects", () => {
    const t = makeTicket({ status: "SUBMITTED" });
    const r = transition(t, { type: "CLASSIFIED", confidence: 0.95 });
    expect(r).toEqual({ ok: true, next: "SUBMITTED", sideEffects: [] });
  });

  it("confidence at the 0.7 boundary stays in SUBMITTED", () => {
    const t = makeTicket({ status: "SUBMITTED" });
    const r = transition(t, { type: "CLASSIFIED", confidence: 0.7 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next).toBe("SUBMITTED");
  });

  it("confidence below 0.7 routes to MANUAL_REVIEW with FM DM", () => {
    const t = makeTicket({ status: "SUBMITTED" });
    const r = transition(t, { type: "CLASSIFIED", confidence: 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("MANUAL_REVIEW");
    expect(r.sideEffects).toHaveLength(1);
    expect(r.sideEffects[0]?.type).toBe(
      "DM_FINANCIAL_MANAGER_MANUAL_REVIEW",
    );
  });

  it("rejects CLASSIFIED from any non-SUBMITTED status", () => {
    for (const status of [
      "AWAITING_APPROVAL",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "CLASSIFIED",
        confidence: 0.9,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(status);
        expect(r.error).toContain("CLASSIFIED");
      }
    }
  });
});

describe("transition: FIRST_DM_SENT", () => {
  it("moves SUBMITTED → AWAITING_APPROVAL", () => {
    const t = makeTicket({ status: "SUBMITTED" });
    const r = transition(t, { type: "FIRST_DM_SENT" });
    expect(r).toEqual({
      ok: true,
      next: "AWAITING_APPROVAL",
      sideEffects: [],
    });
  });

  it("rejects FIRST_DM_SENT from any other status", () => {
    for (const status of [
      "AWAITING_APPROVAL",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), { type: "FIRST_DM_SENT" });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: APPROVE", () => {
  it("non-final step stays AWAITING_APPROVAL with ADVANCE_TO_STEP", () => {
    const t = makeTicket({ status: "AWAITING_APPROVAL", current_step: 1 });
    const r = transition(t, {
      type: "APPROVE",
      step: 1,
      approver_user_id: "U_STEPHAN",
      is_final_step: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("AWAITING_APPROVAL");
    expect(r.sideEffects).toEqual([
      { type: "ADVANCE_TO_STEP", step_number: 2 },
    ]);
  });

  it("non-final step on step 2 advances to step 3", () => {
    const t = makeTicket({ status: "AWAITING_APPROVAL", current_step: 2 });
    const r = transition(t, {
      type: "APPROVE",
      step: 2,
      approver_user_id: "U_TINUS",
      is_final_step: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sideEffects).toEqual([
      { type: "ADVANCE_TO_STEP", step_number: 3 },
    ]);
  });

  it("final step transitions to APPROVED with DM_FINANCIAL_MANAGER_FOR_PAYMENT", () => {
    const t = makeTicket({ status: "AWAITING_APPROVAL", current_step: 3 });
    const r = transition(t, {
      type: "APPROVE",
      step: 3,
      approver_user_id: "U_STEPHAN",
      is_final_step: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("APPROVED");
    expect(r.sideEffects).toEqual([
      { type: "DM_FINANCIAL_MANAGER_FOR_PAYMENT" },
    ]);
  });

  it("rejects APPROVE outside AWAITING_APPROVAL", () => {
    for (const status of [
      "SUBMITTED",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "APPROVE",
        step: 1,
        approver_user_id: "U_X",
        is_final_step: true,
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: REJECT", () => {
  it("AWAITING_APPROVAL → REJECTED with thread post", () => {
    const t = makeTicket({ status: "AWAITING_APPROVAL" });
    const r = transition(t, {
      type: "REJECT",
      step: 1,
      approver_user_id: "U_PATRICK",
      reason: "Out of policy",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("REJECTED");
    expect(r.sideEffects).toEqual([
      {
        type: "POST_REJECTION_TO_THREAD",
        reason: "Out of policy",
        rejected_by: "U_PATRICK",
      },
    ]);
  });

  it("rejects REJECT outside AWAITING_APPROVAL", () => {
    for (const status of [
      "SUBMITTED",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "REJECT",
        step: 1,
        approver_user_id: "U_X",
        reason: "nope",
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: CLARIFY", () => {
  it("AWAITING_APPROVAL → NEEDS_CLARIFICATION with thread + FM DM", () => {
    const t = makeTicket({
      status: "AWAITING_APPROVAL",
      requester_user_id: "U_REQUESTER",
    });
    const r = transition(t, {
      type: "CLARIFY",
      step: 1,
      approver_user_id: "U_PATRICK",
      question: "What is this for?",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("NEEDS_CLARIFICATION");
    expect(r.sideEffects).toHaveLength(2);
    expect(r.sideEffects[0]).toEqual({
      type: "POST_CLARIFICATION_TO_THREAD",
      question: "What is this for?",
      asked_by: "U_PATRICK",
    });
    expect(r.sideEffects[1]).toEqual({
      type: "DM_FINANCIAL_MANAGER_CLARIFICATION",
      requester_user_id: "U_REQUESTER",
    });
  });

  it("rejects CLARIFY outside AWAITING_APPROVAL", () => {
    for (const status of [
      "SUBMITTED",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "CLARIFY",
        step: 1,
        approver_user_id: "U_X",
        question: "?",
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: RESUME_AFTER_CLARIFY", () => {
  it("NEEDS_CLARIFICATION → AWAITING_APPROVAL with re-DM at same step", () => {
    const t = makeTicket({
      status: "NEEDS_CLARIFICATION",
      current_step: 2,
      current_approver_user_id: "U_PATRICK",
    });
    const r = transition(t, { type: "RESUME_AFTER_CLARIFY" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toBe("AWAITING_APPROVAL");
    expect(r.sideEffects).toEqual([{ type: "RE_DM_CURRENT_APPROVER" }]);
  });

  it("rejects RESUME_AFTER_CLARIFY outside NEEDS_CLARIFICATION", () => {
    for (const status of [
      "SUBMITTED",
      "AWAITING_APPROVAL",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "RESUME_AFTER_CLARIFY",
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: MARK_AS_PAID", () => {
  it("APPROVED → AWAITING_PAYMENT with REQUEST_PAYMENT_PROOF_DM", () => {
    const t = makeTicket({ status: "APPROVED" });
    const r = transition(t, { type: "MARK_AS_PAID" });
    expect(r).toEqual({
      ok: true,
      next: "AWAITING_PAYMENT",
      sideEffects: [{ type: "REQUEST_PAYMENT_PROOF_DM" }],
    });
  });

  it("rejects MARK_AS_PAID outside APPROVED", () => {
    for (const status of [
      "SUBMITTED",
      "AWAITING_APPROVAL",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "AWAITING_PAYMENT",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), { type: "MARK_AS_PAID" });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: PAYMENT_CONFIRMED", () => {
  it("AWAITING_PAYMENT → PAID with proof posted to thread", () => {
    const t = makeTicket({ status: "AWAITING_PAYMENT" });
    const r = transition(t, {
      type: "PAYMENT_CONFIRMED",
      file_id: "F_PROOF",
    });
    expect(r).toEqual({
      ok: true,
      next: "PAID",
      sideEffects: [
        { type: "POST_PAYMENT_PROOF_TO_THREAD", file_id: "F_PROOF" },
      ],
    });
  });

  it("rejects PAYMENT_CONFIRMED outside AWAITING_PAYMENT", () => {
    for (const status of [
      "SUBMITTED",
      "AWAITING_APPROVAL",
      "APPROVED",
      "PAID",
      "REJECTED",
      "CANCELLED",
      "MANUAL_REVIEW",
      "NEEDS_CLARIFICATION",
    ] as const) {
      const r = transition(makeTicket({ status }), {
        type: "PAYMENT_CONFIRMED",
        file_id: "F",
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("transition: CANCEL", () => {
  it("cancels from any non-terminal status", () => {
    const nonTerminals: Status[] = [
      "SUBMITTED",
      "AWAITING_APPROVAL",
      "NEEDS_CLARIFICATION",
      "APPROVED",
      "AWAITING_PAYMENT",
      "MANUAL_REVIEW",
    ];
    for (const status of nonTerminals) {
      const r = transition(makeTicket({ status }), {
        type: "CANCEL",
        actor_user_id: "U_REQUESTER",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.next).toBe("CANCELLED");
      expect(r.sideEffects).toEqual([
        {
          type: "POST_CANCELLATION_TO_THREAD",
          cancelled_by: "U_REQUESTER",
        },
      ]);
    }
  });

  it("rejects CANCEL when ticket is already terminal", () => {
    for (const status of ["PAID", "REJECTED", "CANCELLED"] as const) {
      const r = transition(makeTicket({ status }), {
        type: "CANCEL",
        actor_user_id: "U_REQUESTER",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(status);
        expect(r.error).toContain("CANCEL");
      }
    }
  });
});

describe("transition: error message shape", () => {
  it("names the current status and the event type in the error", () => {
    const r = transition(makeTicket({ status: "PAID" }), {
      type: "APPROVE",
      step: 1,
      approver_user_id: "U_X",
      is_final_step: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("PAID");
      expect(r.error).toContain("APPROVE");
    }
  });
});

describe("transition: terminal states are sticky", () => {
  it("rejects every event from PAID", () => {
    const events: StateEvent[] = [
      { type: "CLASSIFIED", confidence: 0.9 },
      { type: "FIRST_DM_SENT" },
      { type: "APPROVE", step: 1, approver_user_id: "U", is_final_step: true },
      { type: "REJECT", step: 1, approver_user_id: "U", reason: "x" },
      { type: "CLARIFY", step: 1, approver_user_id: "U", question: "?" },
      { type: "RESUME_AFTER_CLARIFY" },
      { type: "MARK_AS_PAID" },
      { type: "PAYMENT_CONFIRMED", file_id: "F" },
      { type: "CANCEL", actor_user_id: "U" },
    ];
    for (const e of events) {
      const r = transition(makeTicket({ status: "PAID" }), e);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects every event from REJECTED", () => {
    const events: StateEvent[] = [
      { type: "CLASSIFIED", confidence: 0.9 },
      { type: "APPROVE", step: 1, approver_user_id: "U", is_final_step: true },
      { type: "MARK_AS_PAID" },
      { type: "PAYMENT_CONFIRMED", file_id: "F" },
      { type: "CANCEL", actor_user_id: "U" },
    ];
    for (const e of events) {
      const r = transition(makeTicket({ status: "REJECTED" }), e);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects every event from CANCELLED", () => {
    const events: StateEvent[] = [
      { type: "CLASSIFIED", confidence: 0.9 },
      { type: "APPROVE", step: 1, approver_user_id: "U", is_final_step: true },
      { type: "MARK_AS_PAID" },
      { type: "PAYMENT_CONFIRMED", file_id: "F" },
      { type: "CANCEL", actor_user_id: "U" },
    ];
    for (const e of events) {
      const r = transition(makeTicket({ status: "CANCELLED" }), e);
      expect(r.ok).toBe(false);
    }
  });
});
