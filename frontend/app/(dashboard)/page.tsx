import Link from "next/link";

import { type Ticket } from "@curacel/shared";

import { StatusDonutChart } from "@/components/charts/status-donut-chart";
import { WeeklyPaidChart } from "@/components/charts/weekly-paid-chart";
import { StatusBadge } from "@/components/status-badge";
import {
  aggregateByStatus,
  computeKpis,
  computeMedianTimeToPayDays,
  computePaidPeriodDelta,
  DEFAULT_STUCK_THRESHOLD_DAYS,
  findStuckTickets,
  formatCurrencyCompact,
  formatCurrencyFull,
  summarizeOtherCurrencies,
  topCategoriesPaidThisMonth,
  topRequestersPaidThisMonth,
  weeklyPaid,
  type CategoryTotal,
  type KpiBucket,
  type PeriodDelta,
  type RequesterTotal,
} from "@/lib/dashboard/aggregates";
import { listAllTickets } from "@/lib/sheets/tickets";

export const revalidate = 30;

export const metadata = { title: "Home — Curacel Expense Dashboard" };

const WINDOWS = [12, 26, 52] as const;
type WindowWeeks = (typeof WINDOWS)[number];

function parseWindow(raw: string | string[] | undefined): WindowWeeks {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v?.replace(/[^\d]/g, ""));
  if ((WINDOWS as readonly number[]).includes(n)) return n as WindowWeeks;
  return 12;
}

interface SearchParams {
  window?: string | string[];
}

export default async function DashboardHome({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const windowWeeks = parseWindow(raw.window);

  const tickets = await listAllTickets();

  const kpis = computeKpis(tickets);
  const periodDelta = computePaidPeriodDelta(tickets);
  const statusAgg = aggregateByStatus(tickets);
  const weekly = weeklyPaid(tickets, windowWeeks);
  const topCats = topCategoriesPaidThisMonth(tickets);
  const topReqs = topRequestersPaidThisMonth(tickets);
  const others = summarizeOtherCurrencies(tickets);
  const stuck = findStuckTickets(tickets, DEFAULT_STUCK_THRESHOLD_DAYS);
  const medianDays = computeMedianTimeToPayDays(tickets);
  const recent = tickets.slice(0, 8);

  const weeklyTotal = weekly.reduce((s, p) => s + p.amount, 0);
  const weeklyTicketsTotal = weekly.reduce((s, p) => s + p.count, 0);
  const topCatsAmount = topCats.reduce((s, p) => s + p.amount, 0);
  const topReqsAmount = topReqs.reduce((s, p) => s + p.amount, 0);

  return (
    <div className="space-y-6">
      <div className="animate-in-up">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {tickets.length === 0
            ? "No tickets in the workbook yet."
            : `${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"} in the workbook. Money figures show NGN only.`}
          {others.count > 0 ? (
            <>
              {" "}
              <span className="text-zinc-500">
                {others.count} ticket{others.count === 1 ? "" : "s"} in {others.currencies.join(", ")} not shown — see the queue to filter.
              </span>
            </>
          ) : null}
        </p>
      </div>

      {stuck.length > 0 ? <StuckAlert tickets={stuck} /> : null}

      <section
        className="grid animate-in-up grid-cols-2 gap-3 sm:grid-cols-4"
        style={{ animationDelay: "60ms" }}
      >
        <KpiCard
          label="Awaiting approval"
          bucket={kpis.awaitingApproval}
          tone="amber"
          href="/tickets?status=AWAITING_APPROVAL"
        />
        <KpiCard
          label="Awaiting payment"
          bucket={kpis.awaitingPayment}
          tone="violet"
          href="/tickets?status=AWAITING_PAYMENT"
        />
        <KpiCard
          label="Manual review"
          bucket={kpis.manualReview}
          tone="pink"
          href="/tickets?status=MANUAL_REVIEW"
        />
        <KpiCard
          label="Paid this month"
          bucket={kpis.paidThisMonth}
          tone="emerald"
          href="/tickets?status=PAID"
          delta={periodDelta}
        />
      </section>

      <section
        className="animate-in-up rounded-2xl border border-edge bg-surface p-6"
        style={{ animationDelay: "120ms" }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Paid per week</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {formatCurrencyFull(weeklyTotal)} across {weeklyTicketsTotal}{" "}
              {weeklyTicketsTotal === 1 ? "ticket" : "tickets"}
              {medianDays !== null ? (
                <>
                  {" · "}
                  <span className="text-zinc-500">
                    median {formatDays(medianDays)} to pay
                  </span>
                </>
              ) : null}
              {" · "}
              <span className="text-zinc-500">YTD {formatCurrencyFull(kpis.paidYTD.amount)}</span>
            </p>
          </div>
          <WindowSelector active={windowWeeks} />
        </div>
        <div className="mt-4">
          <WeeklyPaidChart data={weekly} />
        </div>
      </section>

      <div
        className="grid animate-in-up gap-6 lg:grid-cols-2"
        style={{ animationDelay: "180ms" }}
      >
        <section className="rounded-2xl border border-edge bg-surface p-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Status mix</h2>
          <div className="mt-4">
            <StatusDonutChart data={statusAgg} />
          </div>
        </section>

        <section className="rounded-2xl border border-edge bg-surface p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Top categories (paid this month)</h2>
            <span className="text-xs text-zinc-500">{formatCurrencyFull(topCatsAmount)}</span>
          </div>
          {topCats.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">Nothing paid yet this month.</p>
          ) : (
            <ul className="mt-4 space-y-2.5">
              {topCats.map((c) => (
                <CategoryBar key={c.category} cat={c} maxAmount={topCats[0].amount} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <section
        className="animate-in-up rounded-2xl border border-edge bg-surface p-6"
        style={{ animationDelay: "240ms" }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Top requesters (paid this month)</h2>
          <span className="text-xs text-zinc-500">{formatCurrencyFull(topReqsAmount)}</span>
        </div>
        {topReqs.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">Nothing paid yet this month.</p>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {topReqs.map((r) => (
              <RequesterBar key={r.requesterUserId} req={r} maxAmount={topReqs[0].amount} />
            ))}
          </ul>
        )}
      </section>

      <section
        className="animate-in-up rounded-2xl border border-edge bg-surface p-6"
        style={{ animationDelay: "300ms" }}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Recent tickets</h2>
          <Link
            href="/tickets"
            className="text-xs text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            View all →
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            No tickets yet. Submit one in the #expenses Slack channel.
          </p>
        ) : (
          // Real <table> matches the queue page's semantics so AT reads
          // this as tabular data (row/cell relationships, header
          // associations) and column widths align across rows. Previously
          // a flex+fixed-width <ul> drifted when names/descriptions
          // varied in length.
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Tracking ID</th>
                  <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Requester</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Description</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recent.map((t) => (
                  <tr key={t.tracking_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <td className="py-2.5 pr-3 font-mono text-xs">
                      <Link
                        href={`/tickets/${encodeURIComponent(t.tracking_id)}`}
                        className="text-zinc-900 hover:underline dark:text-zinc-50"
                      >
                        {t.tracking_id}
                      </Link>
                    </td>
                    <td className="hidden max-w-[10rem] truncate py-2.5 pr-3 text-zinc-600 md:table-cell dark:text-zinc-400">
                      {t.requester_name}
                    </td>
                    <td className="max-w-0 truncate py-2.5 pr-3">{t.description || "—"}</td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-zinc-700 sm:text-sm dark:text-zinc-300">
                      {t.currency} {t.amount.toLocaleString()}
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={t.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- presentation ----------

type Tone = "amber" | "violet" | "pink" | "emerald";

// Uniform elevated-surface cards instead of full tinted backgrounds —
// the tone shows up as a single colored dot near the label + an arrow
// in the delta line. Less visually busy when four sit side-by-side,
// and the BIG money number gets to be the center of attention.
const TONE_DOTS: Record<Tone, string> = {
  amber: "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.4)]",
  violet: "bg-violet-500 shadow-[0_0_12px_rgba(139,92,246,0.4)]",
  pink: "bg-pink-500 shadow-[0_0_12px_rgba(236,72,153,0.4)]",
  emerald: "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)]",
};

function KpiCard({
  label,
  bucket,
  tone,
  href,
  delta,
}: {
  label: string;
  bucket: KpiBucket;
  tone: Tone;
  href: string;
  delta?: PeriodDelta;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-2xl border border-edge bg-surface-2 p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lg dark:hover:border-zinc-700 dark:hover:shadow-black/40"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${TONE_DOTS[tone]}`} aria-hidden />
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          {label}
        </p>
      </div>
      <p className="mt-4 font-mono text-3xl font-bold tabular-nums tracking-tight">
        {formatCurrencyCompact(bucket.amount)}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        {bucket.count} {bucket.count === 1 ? "ticket" : "tickets"}
      </p>
      {delta ? <DeltaLine delta={delta} /> : null}
    </Link>
  );
}

function DeltaLine({ delta }: { delta: PeriodDelta }) {
  if (delta.percent === null) {
    return (
      <p className="mt-1 text-xs text-zinc-500">no prior month baseline</p>
    );
  }
  const sign = delta.percent >= 0 ? "↑" : "↓";
  const tone =
    delta.percent >= 0
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-red-700 dark:text-red-400";
  const abs = Math.abs(delta.percent);
  // Round to whole percent if >= 10, else 1 decimal.
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return (
    <p className={`mt-1 text-xs font-medium ${tone}`}>
      {sign} {formatted}% vs last month
    </p>
  );
}

function WindowSelector({ active }: { active: WindowWeeks }) {
  return (
    <nav className="inline-flex overflow-hidden rounded-md border border-zinc-200 text-xs dark:border-zinc-800">
      {WINDOWS.map((w) => {
        const isActive = w === active;
        return (
          <Link
            key={w}
            href={`/?window=${w}w`}
            scroll={false}
            className={
              isActive
                ? "bg-zinc-900 px-3 py-1.5 font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "px-3 py-1.5 text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }
          >
            {w}w
          </Link>
        );
      })}
    </nav>
  );
}

function StuckAlert({ tickets }: { tickets: Ticket[] }) {
  const display = tickets.slice(0, 6);
  const more = tickets.length - display.length;
  return (
    <section
      className="animate-in-up rounded-2xl border border-amber-300/80 bg-amber-50/80 p-5 backdrop-blur-sm dark:border-amber-900/60 dark:bg-amber-950/30"
      style={{ animationDelay: "30ms" }}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400"
        >
          ⚠
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {tickets.length} ticket{tickets.length === 1 ? "" : "s"} stuck for &gt;{" "}
            {DEFAULT_STUCK_THRESHOLD_DAYS} days
          </p>
          <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
            Non-terminal tickets that haven&apos;t been updated recently. They may need a nudge.
          </p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {display.map((t) => (
              <li key={t.tracking_id}>
                <Link
                  href={`/tickets/${encodeURIComponent(t.tracking_id)}`}
                  className="inline-flex items-center rounded-md border border-amber-200 bg-white px-2 py-0.5 font-mono text-xs text-amber-900 transition hover:bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-950"
                >
                  {t.tracking_id}{" "}
                  <span className="ml-1.5 text-amber-700/80 dark:text-amber-400/70">
                    · {t.status} · {daysSince(t.updated_at)}d
                  </span>
                </Link>
              </li>
            ))}
            {more > 0 ? (
              <li className="self-center text-xs text-amber-800/80 dark:text-amber-300/80">
                +{more} more
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </section>
  );
}

function CategoryBar({ cat, maxAmount }: { cat: CategoryTotal; maxAmount: number }) {
  const percent = maxAmount === 0 ? 0 : (cat.amount / maxAmount) * 100;
  return (
    <li className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">{cat.category}</span>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div
          className="h-full rounded-full bg-emerald-500"
          style={{ width: `${Math.max(percent, cat.amount > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
        {formatCurrencyCompact(cat.amount)}
      </span>
    </li>
  );
}

function RequesterBar({ req, maxAmount }: { req: RequesterTotal; maxAmount: number }) {
  const percent = maxAmount === 0 ? 0 : (req.amount / maxAmount) * 100;
  return (
    <li className="grid grid-cols-[160px_1fr_auto] items-center gap-3 text-sm">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {req.requesterName || req.requesterUserId}
        </p>
        <p className="truncate font-mono text-[10px] text-zinc-500">{req.requesterUserId}</p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{ width: `${Math.max(percent, req.amount > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
        {formatCurrencyCompact(req.amount)}{" "}
        <span className="text-zinc-500">· {req.count}</span>
      </span>
    </li>
  );
}

function daysSince(iso: string): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function formatDays(d: number): string {
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 14) return `${d.toFixed(1)}d`;
  return `${Math.round(d)}d`;
}
