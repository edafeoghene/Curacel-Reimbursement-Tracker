import { describe, expect, it } from "vitest";

import type { Status, Ticket } from "@curacel/shared";

import {
  aggregateByStatus,
  computeKpis,
  formatCurrencyCompact,
  formatCurrencyFull,
  summarizeOtherCurrencies,
  topCategoriesPaidThisMonth,
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
