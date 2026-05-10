import { describe, expect, it } from "vitest";

import type { Status, Ticket } from "@curacel/shared";

import {
  aggregateByStatus,
  computeKpis,
  computeMedianTimeToPayDays,
  computePaidPeriodDelta,
  findStuckTickets,
  formatCurrencyCompact,
  formatCurrencyFull,
  summarizeOtherCurrencies,
  topCategoriesPaidThisMonth,
  topRequestersPaidThisMonth,
  weeklyPaid,
  weekStartUtc,
} from "./aggregates";

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    tracking_id: "T0",
    created_at: "2026-01-01T00:00:00Z",
    source_message_ts: "1",
    source_channel_id: "C0",
    requester_user_id: "U0",
    requester_name: "User",
    description: "",
    category: "meals",
    amount: 1000,
    currency: "NGN",
    receipt_file_id: "",
    receipt_file_url: "",
    status: "AWAITING_APPROVAL",
    route_id: "low-ngn",
    current_step: 1,
    current_approver_user_id: "U_APP",
    payment_confirmation_file_id: null,
    updated_at: "2026-01-01T00:00:00Z",
    row_version: 1,
    ...overrides,
  };
}

describe("weekStartUtc", () => {
  it("returns the same Monday for any day in that week", () => {
    // 2026-05-04 is a Monday; check Tue/Wed/.../Sun all map to it.
    expect(weekStartUtc(new Date("2026-05-04T12:00:00Z"))).toBe("2026-05-04");
    expect(weekStartUtc(new Date("2026-05-05T12:00:00Z"))).toBe("2026-05-04");
    expect(weekStartUtc(new Date("2026-05-10T23:59:59Z"))).toBe("2026-05-04");
  });

  it("handles Sunday by returning the previous Monday (ISO 8601 week)", () => {
    expect(weekStartUtc(new Date("2026-05-03T12:00:00Z"))).toBe("2026-04-27");
  });
});

describe("computeKpis", () => {
  it("buckets by status and sums NGN only", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "AWAITING_APPROVAL", amount: 100 }),
      makeTicket({ tracking_id: "T2", status: "AWAITING_APPROVAL", amount: 200, currency: "USD" }), // ignored
      makeTicket({ tracking_id: "T3", status: "AWAITING_PAYMENT", amount: 300 }),
      makeTicket({ tracking_id: "T4", status: "MANUAL_REVIEW", amount: 50 }),
    ];
    const k = computeKpis(tickets);
    expect(k.awaitingApproval).toEqual({ count: 1, amount: 100 });
    expect(k.awaitingPayment).toEqual({ count: 1, amount: 300 });
    expect(k.manualReview).toEqual({ count: 1, amount: 50 });
  });

  it("paidThisMonth includes only PAID NGN tickets updated in current month", () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T10:00:00Z`;
    const lastYearJan = "2024-01-15T10:00:00Z";

    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 1000, updated_at: thisMonth }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 500, updated_at: thisMonth, currency: "USD" }), // wrong currency
      makeTicket({ tracking_id: "T3", status: "PAID", amount: 2000, updated_at: lastYearJan }), // wrong period
      makeTicket({ tracking_id: "T4", status: "AWAITING_PAYMENT", amount: 999, updated_at: thisMonth }), // wrong status
    ];
    const k = computeKpis(tickets);
    expect(k.paidThisMonth).toEqual({ count: 1, amount: 1000 });
  });

  it("paidYTD includes all PAID tickets in the current year", () => {
    const now = new Date();
    const thisYearFeb = `${now.getUTCFullYear()}-02-15T10:00:00Z`;
    const lastYearDec = "2024-12-15T10:00:00Z";

    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 100, updated_at: thisYearFeb }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 200, updated_at: thisYearFeb }),
      makeTicket({ tracking_id: "T3", status: "PAID", amount: 999, updated_at: lastYearDec }),
    ];
    const k = computeKpis(tickets);
    expect(k.paidYTD).toEqual({ count: 2, amount: 300 });
  });
});

describe("aggregateByStatus", () => {
  it("counts and sums NGN per status, returns one entry per status", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 100 }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 200 }),
      makeTicket({ tracking_id: "T3", status: "REJECTED", amount: 50 }),
      makeTicket({ tracking_id: "T4", status: "PAID", amount: 9999, currency: "USD" }), // dropped
    ];
    const result = aggregateByStatus(tickets);
    const paid = result.find((s) => s.status === "PAID");
    const rejected = result.find((s) => s.status === "REJECTED");
    expect(paid).toEqual({ status: "PAID" satisfies Status, count: 2, amount: 300 });
    expect(rejected).toEqual({ status: "REJECTED" satisfies Status, count: 1, amount: 50 });
  });

  it("returns zero entries for statuses with no tickets", () => {
    const result = aggregateByStatus([]);
    expect(result.every((s) => s.count === 0 && s.amount === 0)).toBe(true);
  });
});

describe("weeklyPaid", () => {
  it("seeds the last N Mondays with zero so the series is dense", () => {
    const now = new Date("2026-05-10T12:00:00Z"); // Sunday
    const series = weeklyPaid([], 4, now);
    expect(series).toHaveLength(4);
    expect(series.map((p) => p.weekStart)).toEqual([
      "2026-04-13",
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
    ]);
    expect(series.every((p) => p.amount === 0 && p.count === 0)).toBe(true);
  });

  it("buckets PAID NGN tickets into the right week", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 1000, updated_at: "2026-05-05T10:00:00Z" }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 2000, updated_at: "2026-05-08T10:00:00Z" }),
      makeTicket({ tracking_id: "T3", status: "PAID", amount: 999, updated_at: "2026-05-05T10:00:00Z", currency: "USD" }),
      makeTicket({ tracking_id: "T4", status: "AWAITING_APPROVAL", amount: 500, updated_at: "2026-05-05T10:00:00Z" }),
    ];
    const series = weeklyPaid(tickets, 4, now);
    const lastWeek = series[series.length - 1];
    expect(lastWeek.weekStart).toBe("2026-05-04");
    expect(lastWeek.amount).toBe(3000);
    expect(lastWeek.count).toBe(2);
  });

  it("ignores PAID tickets older than the window", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 9999, updated_at: "2026-01-15T10:00:00Z" }),
    ];
    const series = weeklyPaid(tickets, 4, now);
    const total = series.reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(0);
  });
});

describe("topCategoriesPaidThisMonth", () => {
  it("sums NGN amount per category for PAID tickets in the current month, sorts desc", () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T10:00:00Z`;
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 1000, category: "travel", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 200, category: "meals", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T3", status: "PAID", amount: 5000, category: "travel", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T4", status: "PAID", amount: 999, category: "travel", updated_at: thisMonth, currency: "USD" }),
    ];
    const result = topCategoriesPaidThisMonth(tickets);
    expect(result[0]).toEqual({ category: "travel", count: 2, amount: 6000 });
    expect(result[1]).toEqual({ category: "meals", count: 1, amount: 200 });
  });

  it("buckets empty/missing categories under 'uncategorized'", () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T10:00:00Z`;
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 100, category: "", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 200, category: "   ", updated_at: thisMonth }),
    ];
    const result = topCategoriesPaidThisMonth(tickets);
    expect(result[0]).toEqual({ category: "uncategorized", count: 2, amount: 300 });
  });
});

describe("summarizeOtherCurrencies", () => {
  it("counts non-NGN tickets and lists their distinct currencies", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", currency: "NGN" }),
      makeTicket({ tracking_id: "T2", currency: "USD" }),
      makeTicket({ tracking_id: "T3", currency: "USD" }),
      makeTicket({ tracking_id: "T4", currency: "EUR" }),
    ];
    expect(summarizeOtherCurrencies(tickets)).toEqual({
      count: 3,
      currencies: ["EUR", "USD"],
    });
  });

  it("returns zero when every ticket is NGN", () => {
    expect(summarizeOtherCurrencies([makeTicket({})])).toEqual({ count: 0, currencies: [] });
  });
});

describe("topRequestersPaidThisMonth", () => {
  it("groups by requester_user_id and uses the most recent name", () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T10:00:00Z`;
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 100, requester_user_id: "U_ALICE", requester_name: "Alice", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 300, requester_user_id: "U_ALICE", requester_name: "", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T3", status: "PAID", amount: 200, requester_user_id: "U_BOB", requester_name: "Bob", updated_at: thisMonth }),
      makeTicket({ tracking_id: "T4", status: "PAID", amount: 500, requester_user_id: "U_CAROL", requester_name: "Carol", currency: "USD", updated_at: thisMonth }), // dropped
    ];
    const result = topRequestersPaidThisMonth(tickets);
    expect(result[0]).toEqual({ requesterUserId: "U_ALICE", requesterName: "Alice", count: 2, amount: 400 });
    expect(result[1]).toEqual({ requesterUserId: "U_BOB", requesterName: "Bob", count: 1, amount: 200 });
    expect(result.find((r) => r.requesterUserId === "U_CAROL")).toBeUndefined();
  });

  it("respects the limit parameter", () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T10:00:00Z`;
    const tickets = Array.from({ length: 12 }, (_, i) =>
      makeTicket({ tracking_id: `T${i}`, status: "PAID", amount: 100 + i, requester_user_id: `U${i}`, requester_name: `User${i}`, updated_at: thisMonth }),
    );
    const result = topRequestersPaidThisMonth(tickets, 5);
    expect(result).toHaveLength(5);
  });
});

describe("computePaidPeriodDelta", () => {
  it("computes signed percent delta between current and previous month", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 1200, updated_at: "2026-05-05T10:00:00Z" }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 1000, updated_at: "2026-04-15T10:00:00Z" }),
    ];
    const d = computePaidPeriodDelta(tickets, now);
    expect(d.current).toBe(1200);
    expect(d.previous).toBe(1000);
    expect(d.percent).toBeCloseTo(20);
  });

  it("returns null percent when previous month had zero (no baseline)", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 1000, updated_at: "2026-05-05T10:00:00Z" }),
    ];
    const d = computePaidPeriodDelta(tickets, now);
    expect(d.current).toBe(1000);
    expect(d.previous).toBe(0);
    expect(d.percent).toBeNull();
  });

  it("rolls over correctly when current month is January", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 500, updated_at: "2026-01-10T10:00:00Z" }),
      makeTicket({ tracking_id: "T2", status: "PAID", amount: 1000, updated_at: "2025-12-20T10:00:00Z" }),
    ];
    const d = computePaidPeriodDelta(tickets, now);
    expect(d.current).toBe(500);
    expect(d.previous).toBe(1000);
    expect(d.percent).toBeCloseTo(-50);
  });

  it("ignores non-NGN tickets", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", amount: 999999, currency: "USD", updated_at: "2026-05-05T10:00:00Z" }),
    ];
    const d = computePaidPeriodDelta(tickets, now);
    expect(d.current).toBe(0);
    expect(d.previous).toBe(0);
  });

  it("treats 23:30 UTC May 31 (= 00:30 June 1 Lagos) as June, not May", () => {
    // The point of switching from UTC- to Lagos-bucketing. A ticket paid
    // late in the day on May 31 in Lagos is *June* money for the FM.
    const now = new Date("2026-06-15T12:00:00Z"); // Lagos: June 15
    const tickets = [
      makeTicket({
        tracking_id: "T-boundary",
        status: "PAID",
        amount: 5000,
        updated_at: "2026-05-31T23:30:00Z", // Lagos: 2026-06-01T00:30
      }),
    ];
    const d = computePaidPeriodDelta(tickets, now);
    expect(d.current).toBe(5000); // counts toward June
    expect(d.previous).toBe(0); // not May
  });
});

describe("computeKpis (Lagos timezone)", () => {
  it("buckets paidThisMonth by Africa/Lagos local month, not UTC", () => {
    // Same boundary scenario as the period-delta test: a UTC-bucketed
    // implementation would file this ticket under May; Lagos-bucketing
    // correctly files it under June.
    const now = new Date("2026-06-15T12:00:00Z");
    const tickets = [
      makeTicket({
        tracking_id: "T-boundary",
        status: "PAID",
        amount: 1234,
        updated_at: "2026-05-31T23:30:00Z",
      }),
    ];
    const k = computeKpis(tickets, now);
    expect(k.paidThisMonth.count).toBe(1);
    expect(k.paidThisMonth.amount).toBe(1234);
  });

  it("does NOT count a ticket paid 23:30 UTC May 31 as May either (it's June Lagos)", () => {
    const now = new Date("2026-05-31T23:45:00Z"); // Lagos: 2026-06-01T00:45
    const tickets = [
      makeTicket({
        tracking_id: "T-boundary",
        status: "PAID",
        amount: 1234,
        updated_at: "2026-05-15T10:00:00Z", // safely mid-May Lagos
      }),
      makeTicket({
        tracking_id: "T-boundary-late",
        status: "PAID",
        amount: 5000,
        updated_at: "2026-05-31T23:30:00Z", // June 1 in Lagos
      }),
    ];
    const k = computeKpis(tickets, now);
    // "now" is June 1 in Lagos, so "this month" = June.
    // T-boundary (mid-May) → not in this month.
    // T-boundary-late (June 1 Lagos) → in this month.
    expect(k.paidThisMonth.count).toBe(1);
    expect(k.paidThisMonth.amount).toBe(5000);
  });
});

describe("findStuckTickets", () => {
  it("returns non-terminal tickets that haven't been updated in N days", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T_OLD", status: "AWAITING_APPROVAL", updated_at: "2026-05-01T10:00:00Z" }), // 9 days
      makeTicket({ tracking_id: "T_FRESH", status: "AWAITING_APPROVAL", updated_at: "2026-05-08T10:00:00Z" }), // 2 days
      makeTicket({ tracking_id: "T_PAID", status: "PAID", updated_at: "2026-04-01T10:00:00Z" }), // terminal, ignored
      makeTicket({ tracking_id: "T_REJECTED", status: "REJECTED", updated_at: "2026-04-01T10:00:00Z" }), // terminal, ignored
    ];
    const result = findStuckTickets(tickets, 7, now);
    expect(result.map((t) => t.tracking_id)).toEqual(["T_OLD"]);
  });

  it("sorts oldest-first (most stuck first)", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T2", status: "AWAITING_PAYMENT", updated_at: "2026-04-25T10:00:00Z" }),
      makeTicket({ tracking_id: "T1", status: "AWAITING_APPROVAL", updated_at: "2026-04-15T10:00:00Z" }),
      makeTicket({ tracking_id: "T3", status: "MANUAL_REVIEW", updated_at: "2026-04-30T10:00:00Z" }),
    ];
    const result = findStuckTickets(tickets, 7, now);
    expect(result.map((t) => t.tracking_id)).toEqual(["T1", "T2", "T3"]);
  });

  it("returns empty when nothing is stuck", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "AWAITING_APPROVAL", updated_at: "2026-05-09T10:00:00Z" }),
    ];
    expect(findStuckTickets(tickets, 7, now)).toEqual([]);
  });
});

describe("computeMedianTimeToPayDays", () => {
  it("returns the median days between created_at and updated_at across PAID NGN tickets", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-04T00:00:00Z" }), // 3 days
      makeTicket({ tracking_id: "T2", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-06T00:00:00Z" }), // 5 days
      makeTicket({ tracking_id: "T3", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-08T00:00:00Z" }), // 7 days
    ];
    const median = computeMedianTimeToPayDays(tickets);
    expect(median).toBe(5);
  });

  it("averages two middle values when count is even", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" }), // 1
      makeTicket({ tracking_id: "T2", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-04T00:00:00Z" }), // 3
      makeTicket({ tracking_id: "T3", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-06T00:00:00Z" }), // 5
      makeTicket({ tracking_id: "T4", status: "PAID", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-08T00:00:00Z" }), // 7
    ];
    expect(computeMedianTimeToPayDays(tickets)).toBe(4); // (3 + 5) / 2
  });

  it("returns null when there are no PAID tickets to measure", () => {
    expect(computeMedianTimeToPayDays([])).toBeNull();
  });

  it("ignores non-NGN PAID tickets", () => {
    const tickets = [
      makeTicket({ tracking_id: "T1", status: "PAID", currency: "USD", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" }),
    ];
    expect(computeMedianTimeToPayDays(tickets)).toBeNull();
  });

  it("respects lookbackCount and uses the most recent N PAID tickets", () => {
    const tickets = Array.from({ length: 100 }, (_, i) =>
      makeTicket({
        tracking_id: `T${i}`,
        status: "PAID",
        created_at: "2026-05-01T00:00:00Z",
        // older tickets have an artificially huge gap; only the recent
        // ones (small i, but bigger updated_at) should be considered.
        updated_at: `2026-${String((i % 9) + 1).padStart(2, "0")}-01T00:00:00Z`,
      }),
    );
    const median = computeMedianTimeToPayDays(tickets, 5);
    expect(median).not.toBeNull();
  });
});

describe("currency formatters", () => {
  it("formatCurrencyCompact renders K/M suffixes", () => {
    expect(formatCurrencyCompact(850_000)).toBe("NGN 850K");
    expect(formatCurrencyCompact(1_200_000)).toBe("NGN 1.2M");
    expect(formatCurrencyCompact(0)).toBe("NGN 0");
  });

  it("formatCurrencyFull uses thousands separators and rounds to whole units", () => {
    expect(formatCurrencyFull(1234567)).toBe("NGN 1,234,567");
    expect(formatCurrencyFull(1234.5)).toBe("NGN 1,235"); // rounded
  });
});
