import { describe, expect, it } from "vitest";

import type { Ticket } from "@curacel/shared";

import { applyTicketFilters } from "./tickets";

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    tracking_id: "EXP-2605-AAAA",
    created_at: "2026-05-10T10:00:00Z",
    source_message_ts: "1",
    source_channel_id: "C0",
    requester_user_id: "U_ALICE",
    requester_name: "Alice",
    description: "",
    category: "meals",
    amount: 100,
    currency: "NGN",
    receipt_file_id: "",
    receipt_file_url: "",
    status: "AWAITING_APPROVAL",
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "U_APPROVER",
    payment_confirmation_file_id: null,
    updated_at: "2026-05-10T10:00:00Z",
    row_version: 1,
    ...overrides,
  };
}

const TICKETS = [
  makeTicket({ tracking_id: "T1", status: "PAID", currency: "NGN", requester_user_id: "U_ALICE", route_id: "low-ngn", created_at: "2026-05-09T00:00:00Z" }),
  makeTicket({ tracking_id: "T2", status: "AWAITING_APPROVAL", currency: "USD", requester_user_id: "U_BOB", route_id: "high-usd", created_at: "2026-05-10T00:00:00Z" }),
  makeTicket({ tracking_id: "T3", status: "REJECTED", currency: "NGN", requester_user_id: "U_ALICE", route_id: "mid-ngn", created_at: "2026-05-11T00:00:00Z" }),
];

describe("applyTicketFilters", () => {
  it("returns a copy of the input when filters is undefined", () => {
    const result = applyTicketFilters(TICKETS, undefined);
    expect(result).toEqual(TICKETS);
    expect(result).not.toBe(TICKETS); // copy, not aliased
  });

  it("filters by status", () => {
    const result = applyTicketFilters(TICKETS, { status: "PAID" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T1"]);
  });

  it("filters by requesterUserId", () => {
    const result = applyTicketFilters(TICKETS, { requesterUserId: "U_ALICE" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T1", "T3"]);
  });

  it("filters by routeId", () => {
    const result = applyTicketFilters(TICKETS, { routeId: "high-usd" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T2"]);
  });

  it("filters by currency", () => {
    const result = applyTicketFilters(TICKETS, { currency: "NGN" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T1", "T3"]);
  });

  it("filters by createdFrom (inclusive)", () => {
    const result = applyTicketFilters(TICKETS, { createdFrom: "2026-05-10T00:00:00Z" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T2", "T3"]);
  });

  it("filters by createdTo (inclusive)", () => {
    const result = applyTicketFilters(TICKETS, { createdTo: "2026-05-10T00:00:00Z" });
    expect(result.map((t) => t.tracking_id)).toEqual(["T1", "T2"]);
  });

  it("ANDs multiple filters together", () => {
    const result = applyTicketFilters(TICKETS, {
      currency: "NGN",
      requesterUserId: "U_ALICE",
      status: "PAID",
    });
    expect(result.map((t) => t.tracking_id)).toEqual(["T1"]);
  });

  it("returns empty when no ticket matches", () => {
    const result = applyTicketFilters(TICKETS, { status: "MANUAL_REVIEW" });
    expect(result).toEqual([]);
  });
});
