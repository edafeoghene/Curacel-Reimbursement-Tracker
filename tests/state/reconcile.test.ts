import { describe, expect, it } from "vitest";
import {
  NON_TERMINAL_STATUSES,
  isNonTerminal,
  partitionForReconciliation,
} from "../../src/state/reconcile.js";
import type { Ticket, Status } from "../../src/types.js";

function makeTicket(status: Status, tracking_id: string): Ticket {
  return {
    tracking_id,
    created_at: "2026-05-09T10:00:00.000Z",
    source_message_ts: "1715251200.000100",
    source_channel_id: "C_EXPENSES",
    requester_user_id: "U_REQUESTER",
    requester_name: "Edafe",
    description: "Test",
    category: "equipment",
    amount: 1000,
    currency: "NGN",
    receipt_file_id: "F_001",
    receipt_file_url: "https://example.com",
    status,
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "U_STEPHAN",
    payment_confirmation_file_id: null,
    updated_at: "2026-05-09T10:00:00.000Z",
    row_version: 1,
  };
}

describe("NON_TERMINAL_STATUSES", () => {
  it("contains exactly the six in-flight statuses", () => {
    // Snapshot to catch accidental additions/removals.
    expect([...NON_TERMINAL_STATUSES].sort()).toEqual(
      [
        "APPROVED",
        "AWAITING_APPROVAL",
        "AWAITING_PAYMENT",
        "MANUAL_REVIEW",
        "NEEDS_CLARIFICATION",
        "SUBMITTED",
      ].sort(),
    );
  });

  it("does not include any terminal status", () => {
    expect(NON_TERMINAL_STATUSES).not.toContain("PAID");
    expect(NON_TERMINAL_STATUSES).not.toContain("REJECTED");
    expect(NON_TERMINAL_STATUSES).not.toContain("CANCELLED");
  });
});

describe("isNonTerminal", () => {
  it("returns true for every non-terminal status", () => {
    for (const s of NON_TERMINAL_STATUSES) {
      expect(isNonTerminal(s)).toBe(true);
    }
  });

  it("returns false for terminal statuses", () => {
    expect(isNonTerminal("PAID")).toBe(false);
    expect(isNonTerminal("REJECTED")).toBe(false);
    expect(isNonTerminal("CANCELLED")).toBe(false);
  });
});

describe("partitionForReconciliation", () => {
  it("returns empty buckets on empty input", () => {
    expect(partitionForReconciliation([])).toEqual({
      toResume: [],
      terminal: [],
    });
  });

  it("splits a mixed list correctly", () => {
    const tickets = [
      makeTicket("SUBMITTED", "EXP-2605-AAAA"),
      makeTicket("PAID", "EXP-2605-BBBB"),
      makeTicket("AWAITING_APPROVAL", "EXP-2605-CCCC"),
      makeTicket("REJECTED", "EXP-2605-DDDD"),
      makeTicket("AWAITING_PAYMENT", "EXP-2605-EEEE"),
      makeTicket("CANCELLED", "EXP-2605-FFFF"),
      makeTicket("MANUAL_REVIEW", "EXP-2605-GGGG"),
      makeTicket("NEEDS_CLARIFICATION", "EXP-2605-HHHH"),
      makeTicket("APPROVED", "EXP-2605-JJJJ"),
    ];
    const { toResume, terminal } = partitionForReconciliation(tickets);
    expect(toResume.map((t) => t.tracking_id)).toEqual([
      "EXP-2605-AAAA",
      "EXP-2605-CCCC",
      "EXP-2605-EEEE",
      "EXP-2605-GGGG",
      "EXP-2605-HHHH",
      "EXP-2605-JJJJ",
    ]);
    expect(terminal.map((t) => t.tracking_id)).toEqual([
      "EXP-2605-BBBB",
      "EXP-2605-DDDD",
      "EXP-2605-FFFF",
    ]);
  });

  it("preserves input order within each bucket", () => {
    const tickets = [
      makeTicket("AWAITING_APPROVAL", "T1"),
      makeTicket("AWAITING_APPROVAL", "T2"),
      makeTicket("AWAITING_APPROVAL", "T3"),
    ];
    const { toResume } = partitionForReconciliation(tickets);
    expect(toResume.map((t) => t.tracking_id)).toEqual(["T1", "T2", "T3"]);
  });

  it("places only terminal tickets in `terminal`", () => {
    const tickets = [
      makeTicket("PAID", "P1"),
      makeTicket("REJECTED", "R1"),
      makeTicket("CANCELLED", "C1"),
    ];
    const { toResume, terminal } = partitionForReconciliation(tickets);
    expect(toResume).toEqual([]);
    expect(terminal).toHaveLength(3);
  });

  it("places only in-flight tickets in `toResume`", () => {
    const tickets: Ticket[] = NON_TERMINAL_STATUSES.map((s, i) =>
      makeTicket(s, `T${i}`),
    );
    const { toResume, terminal } = partitionForReconciliation(tickets);
    expect(toResume).toHaveLength(NON_TERMINAL_STATUSES.length);
    expect(terminal).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const tickets = [
      makeTicket("PAID", "P1"),
      makeTicket("SUBMITTED", "S1"),
    ];
    const snapshot = [...tickets];
    partitionForReconciliation(tickets);
    expect(tickets).toEqual(snapshot);
  });
});
