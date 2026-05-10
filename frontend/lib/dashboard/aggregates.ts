// Pure aggregations for the homepage. All inputs are read-only Ticket[].
// All money figures are NGN-only (Curacel's operating currency); the page
// surfaces a footnote when non-NGN tickets exist so the FM knows the
// charts aren't lying about the totals.

import {
  isTerminalStatus,
  TICKET_STATUSES,
  type Status,
  type Ticket,
} from "@curacel/shared";

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

export interface RequesterTotal {
  requesterUserId: string;
  /** Most recent display name we saw for this requester. */
  requesterName: string;
  count: number;
  amount: number;
}

export interface PeriodDelta {
  /** NGN amount paid in the current calendar month. */
  current: number;
  /** NGN amount paid in the previous calendar month. */
  previous: number;
  /** Signed percent change vs previous month. null when previous is 0. */
  percent: number | null;
}

/**
 * Stuck-ticket configuration. A ticket is "stuck" if its status is non-
 * terminal AND it has not been updated in `daysWithoutUpdate` days. Tied
 * to updated_at (not created_at) so a ticket actively progressing through
 * approvals doesn't trip the alert just because it was opened a while ago.
 */
export const DEFAULT_STUCK_THRESHOLD_DAYS = 7;

// ---------- helpers ----------

function isNgn(t: Ticket): boolean {
  return t.currency === PRIMARY_CURRENCY;
}

// ---------- Lagos / WAT timezone helpers ----------
//
// Curacel operates in Lagos (Africa/Lagos = UTC+1, no DST). The bot
// writes timestamps as ISO-8601 UTC; if we bucket those timestamps by
// the UTC calendar month, "Paid this month" KPI rolls over ~1 hour late
// on the 1st (a ticket paid 23:30 UTC on May 31 is 00:30 June 1 Lagos,
// but a UTC-bucket would file it under May). For financial-display
// correctness we bucket months by Africa/Lagos local time instead.
//
// Implementation: shift the Date forward by 1h, then read its UTC
// year/month. Pure offset arithmetic — no DST table, no Intl.

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // WAT = UTC+1, year-round.

function toLagos(d: Date): Date {
  return new Date(d.getTime() + LAGOS_OFFSET_MS);
}

/** YYYY-MM prefix of `d` in Africa/Lagos local time. */
export function lagosMonthPrefix(d: Date): string {
  const l = toLagos(d);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** YYYY-MM prefix of the calendar month before `d` in Lagos. */
function previousLagosMonthPrefix(d: Date): string {
  const l = toLagos(d);
  const y = l.getUTCFullYear();
  const m = l.getUTCMonth();
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 12 : m;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/** YYYY prefix of `d` in Africa/Lagos local time. */
function lagosYearPrefix(d: Date): string {
  return String(toLagos(d).getUTCFullYear());
}

function isInLagosMonth(iso: string, prefix: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  return lagosMonthPrefix(d) === prefix;
}

function isInLagosYear(iso: string, prefix: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  return lagosYearPrefix(d) === prefix;
}

function isInCurrentLagosMonth(iso: string, now: Date = new Date()): boolean {
  return isInLagosMonth(iso, lagosMonthPrefix(now));
}

function isInCurrentLagosYear(iso: string, now: Date = new Date()): boolean {
  return isInLagosYear(iso, lagosYearPrefix(now));
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

export function computeKpis(
  tickets: readonly Ticket[],
  now: Date = new Date(),
): DashboardKpis {
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
        if (isInCurrentLagosMonth(t.updated_at, now)) {
          out.paidThisMonth.count += 1;
          out.paidThisMonth.amount += t.amount;
        }
        if (isInCurrentLagosYear(t.updated_at, now)) {
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
  now: Date = new Date(),
): CategoryTotal[] {
  const byCategory = new Map<string, CategoryTotal>();
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    if (t.status !== "PAID") continue;
    if (!isInCurrentLagosMonth(t.updated_at, now)) continue;
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

/**
 * Top requesters by NGN paid this month. Groups by requester_user_id and
 * uses the most recent non-empty `requester_name` as the display label.
 */
export function topRequestersPaidThisMonth(
  tickets: readonly Ticket[],
  limit = 8,
  now: Date = new Date(),
): RequesterTotal[] {
  const byUser = new Map<string, RequesterTotal>();
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    if (t.status !== "PAID") continue;
    if (!isInCurrentLagosMonth(t.updated_at, now)) continue;
    const existing = byUser.get(t.requester_user_id);
    if (existing) {
      existing.count += 1;
      existing.amount += t.amount;
      if (!existing.requesterName && t.requester_name) {
        existing.requesterName = t.requester_name;
      }
    } else {
      byUser.set(t.requester_user_id, {
        requesterUserId: t.requester_user_id,
        requesterName: t.requester_name,
        count: 1,
        amount: t.amount,
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

/**
 * NGN paid this month vs previous calendar month, with percent delta.
 * Returns percent: null when there's no previous-month baseline (no
 * ratio to compute from zero).
 */
export function computePaidPeriodDelta(
  tickets: readonly Ticket[],
  now: Date = new Date(),
): PeriodDelta {
  const currentPrefix = lagosMonthPrefix(now);
  const prevPrefix = previousLagosMonthPrefix(now);
  let current = 0;
  let previous = 0;
  for (const t of tickets) {
    if (!isNgn(t)) continue;
    if (t.status !== "PAID") continue;
    if (isInLagosMonth(t.updated_at, currentPrefix)) current += t.amount;
    else if (isInLagosMonth(t.updated_at, prevPrefix)) previous += t.amount;
  }
  const percent = previous === 0 ? null : ((current - previous) / previous) * 100;
  return { current, previous, percent };
}

/**
 * Tickets whose status is non-terminal AND haven't been updated in
 * `days` days. Sorted oldest-first (most-stuck first). Used by the
 * homepage "stuck tickets" alert — the most actionable signal an FM can
 * see at a glance.
 */
export function findStuckTickets(
  tickets: readonly Ticket[],
  days: number = DEFAULT_STUCK_THRESHOLD_DAYS,
  now: Date = new Date(),
): Ticket[] {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const out: Ticket[] = [];
  for (const t of tickets) {
    if (isTerminalStatus(t.status)) continue;
    if (!t.updated_at) continue;
    const updatedMs = new Date(t.updated_at).getTime();
    if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) {
      out.push(t);
    }
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
  return out;
}

/**
 * Median time-to-pay across the most recent N PAID tickets (NGN only).
 * Returns null when there isn't a single PAID ticket to compute from.
 *
 * Operates on the last `lookbackCount` PAID tickets rather than a date
 * window so the metric stays meaningful when volume is low.
 */
export function computeMedianTimeToPayDays(
  tickets: readonly Ticket[],
  lookbackCount = 30,
): number | null {
  const candidates: number[] = [];
  const sorted = tickets
    .filter((t) => isNgn(t) && t.status === "PAID" && t.created_at && t.updated_at)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, lookbackCount);
  for (const t of sorted) {
    const ms = new Date(t.updated_at).getTime() - new Date(t.created_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) candidates.push(ms / (24 * 60 * 60 * 1000));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a - b);
  const mid = Math.floor(candidates.length / 2);
  return candidates.length % 2 === 0
    ? (candidates[mid - 1] + candidates[mid]) / 2
    : candidates[mid];
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
