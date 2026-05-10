// Pure aggregations for the homepage. All inputs are read-only Ticket[].
// All money figures are NGN-only (Curacel's operating currency); the page
// surfaces a footnote when non-NGN tickets exist so the FM knows the
// charts aren't lying about the totals.

import { TICKET_STATUSES, type Status, type Ticket } from "@curacel/shared";

export const PRIMARY_CURRENCY = "NGN";

// ---------- shapes ----------

export interface KpiBucket {
  count: number;
  amount: number;
}

export interface DashboardKpis {
  awaitingApproval: KpiBucket;
  awaitingPayment: KpiBucket;
  manualReview: KpiBucket;
  paidThisMonth: KpiBucket;
  paidYTD: KpiBucket;
}

export interface StatusAggregate {
  status: Status;
  count: number;
  amount: number;
}

export interface WeeklyPaidPoint {
  /** ISO date (YYYY-MM-DD) of the Monday that starts the week. */
  weekStart: string;
  /** Short label for the chart x-axis, e.g. "May 5". */
  weekLabel: string;
  amount: number;
  count: number;
}

export interface CategoryTotal {
  category: string;
  count: number;
  amount: number;
}

export interface OtherCurrencySummary {
  /** Number of tickets whose currency !== PRIMARY_CURRENCY. */
  count: number;
  /** Set of distinct currency codes seen, sorted alphabetically. */
  currencies: string[];
}

// ---------- helpers ----------

function isNgn(t: Ticket): boolean {
  return t.currency === PRIMARY_CURRENCY;
}

/** Returns true iff `iso` falls in the current UTC month. */
function isInCurrentMonth(iso: string): boolean {
  if (!iso) return false;
  const now = new Date();
  const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return iso.startsWith(prefix);
}

function isInCurrentYear(iso: string): boolean {
  if (!iso) return false;
  const prefix = String(new Date().getUTCFullYear());
  return iso.startsWith(prefix);
}

/**
 * UTC Monday of the week containing `date`. Returned as YYYY-MM-DD so it
 * sorts lexicographically the same way it sorts chronologically.
 */
export function weekStartUtc(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay: Sun=0..Sat=6. We want Mon=0, so map Sun→6, then subtract.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** "May 5" style label for a YYYY-MM-DD week-start. */
function shortWeekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ---------- aggregations ----------

export function computeKpis(tickets: readonly Ticket[]): DashboardKpis {
  const empty = (): KpiBucket => ({ count: 0, amount: 0 });
  const out: DashboardKpis = {
    awaitingApproval: empty(),
    awaitingPayment: empty(),
    manualReview: empty(),
    paidThisMonth: empty(),
    paidYTD: empty(),
  };
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    switch (t.status) {
      case "AWAITING_APPROVAL":
        out.awaitingApproval.count += 1;
        out.awaitingApproval.amount += t.amount;
        break;
      case "AWAITING_PAYMENT":
        out.awaitingPayment.count += 1;
        out.awaitingPayment.amount += t.amount;
        break;
      case "MANUAL_REVIEW":
        out.manualReview.count += 1;
        out.manualReview.amount += t.amount;
        break;
      case "PAID":
        if (isInCurrentMonth(t.updated_at)) {
          out.paidThisMonth.count += 1;
          out.paidThisMonth.amount += t.amount;
        }
        if (isInCurrentYear(t.updated_at)) {
          out.paidYTD.count += 1;
          out.paidYTD.amount += t.amount;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function aggregateByStatus(tickets: readonly Ticket[]): StatusAggregate[] {
  const init: Record<Status, StatusAggregate> = Object.fromEntries(
    TICKET_STATUSES.map((s) => [s, { status: s, count: 0, amount: 0 }]),
  ) as Record<Status, StatusAggregate>;
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    init[t.status].count += 1;
    init[t.status].amount += t.amount;
  }
  return Object.values(init);
}

/**
 * Weekly NGN amount paid out for the last `weeks` (UTC). Weeks the user
 * had no PAID activity show as zero — produces a contiguous time series
 * that doesn't skip gaps in the chart.
 */
export function weeklyPaid(
  tickets: readonly Ticket[],
  weeks = 12,
  now: Date = new Date(),
): WeeklyPaidPoint[] {
  const buckets = new Map<string, WeeklyPaidPoint>();

  // Seed the last `weeks` Mondays with zero so the chart x-axis is dense.
  const thisMonday = new Date(`${weekStartUtc(now)}T00:00:00Z`);
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisMonday);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const ws = d.toISOString().slice(0, 10);
    buckets.set(ws, { weekStart: ws, weekLabel: shortWeekLabel(ws), amount: 0, count: 0 });
  }

  for (const t of tickets) {
    if (!isNgn(t)) continue;
    if (t.status !== "PAID") continue;
    if (!t.updated_at) continue;
    const ws = weekStartUtc(new Date(t.updated_at));
    const b = buckets.get(ws);
    if (!b) continue; // outside the last `weeks`
    b.amount += t.amount;
    b.count += 1;
  }

  return [...buckets.values()].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
  );
}

/**
 * Top categories by NGN paid this month. Categories are taken verbatim
 * from `t.category`; empty/missing categories are bucketed as
 * "uncategorized" rather than dropped.
 */
export function topCategoriesPaidThisMonth(
  tickets: readonly Ticket[],
  limit = 8,
): CategoryTotal[] {
  const byCategory = new Map<string, CategoryTotal>();
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    if (t.status !== "PAID") continue;
    if (!isInCurrentMonth(t.updated_at)) continue;
    const cat = t.category?.trim() || "uncategorized";
    const entry = byCategory.get(cat);
    if (entry) {
      entry.count += 1;
      entry.amount += t.amount;
    } else {
      byCategory.set(cat, { category: cat, count: 1, amount: t.amount });
    }
  }
  return [...byCategory.values()].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

export function summarizeOtherCurrencies(tickets: readonly Ticket[]): OtherCurrencySummary {
  let count = 0;
  const currencies = new Set<string>();
  for (const t of tickets) {
    if (isNgn(t)) continue;
    count += 1;
    if (t.currency) currencies.add(t.currency);
  }
  return { count, currencies: [...currencies].sort() };
}

// ---------- formatters ----------

/** Compact NGN currency formatting, e.g. "NGN 1.2M" or "NGN 850K". */
export function formatCurrencyCompact(amount: number, currency = PRIMARY_CURRENCY): string {
  const formatter = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return `${currency} ${formatter.format(amount)}`;
}

/** Full NGN currency formatting, e.g. "NGN 1,234,567". */
export function formatCurrencyFull(amount: number, currency = PRIMARY_CURRENCY): string {
  const formatter = new Intl.NumberFormat("en-US");
  return `${currency} ${formatter.format(Math.round(amount))}`;
}
