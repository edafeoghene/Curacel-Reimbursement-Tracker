import Link from "next/link";

import { type Status, type Ticket } from "@curacel/shared";

import { StatusDonutChart } from "@/components/charts/status-donut-chart";
import { WeeklyPaidChart } from "@/components/charts/weekly-paid-chart";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
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

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Paid per week</h2>
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

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Status mix</h2>
          <div className="mt-4">
            <StatusDonutChart data={statusAgg} />
          </div>
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Top categories (paid this month)</h2>
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

      <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Top requesters (paid this month)</h2>
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

      <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent tickets</h2>
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
          <ul className="mt-4 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {recent.map((t) => (
              <li key={t.tracking_id} className="flex items-center gap-4 py-2.5">
                <Link
                  href={`/tickets/${encodeURIComponent(t.tracking_id)}`}
                  className="w-36 shrink-0 font-mono text-xs text-zinc-900 hover:underline dark:text-zinc-50"
                >
                  {t.tracking_id}
                </Link>
                <span className="hidden w-32 truncate text-zinc-600 dark:text-zinc-400 sm:inline">
                  {t.requester_name}
                </span>
                <span className="flex-1 truncate">{t.description || "—"}</span>
                <span className="hidden font-mono text-zinc-700 dark:text-zinc-300 md:inline">
                  {t.currency} {t.amount.toLocaleString()}
                </span>
                <StatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------- presentation ----------

type Tone = "amber" | "violet" | "pink" | "emerald";

const KPI_TONES: Record<Tone, string> = {
  amber: "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40",
  violet: "border-violet-200 bg-violet-50 dark:border-violet-900/60 dark:bg-violet-950/40",
  pink: "border-pink-200 bg-pink-50 dark:border-pink-900/60 dark:bg-pink-950/40",
  emerald: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40",
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
      className={`group block rounded-md border p-4 transition hover:shadow-sm ${KPI_TONES[tone]}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums tracking-tight">
        {formatCurrencyCompact(bucket.amount)}
      </p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
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
    <section className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/40">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 text-amber-700 dark:text-amber-400">
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
                  className="inline-flex items-center rounded border border-amber-200 bg-white px-2 py-0.5 font-mono text-xs text-amber-900 transition hover:bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-950"
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

const STATUS_BADGE_TONE: Record<Status, string> = {
  SUBMITTED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  AWAITING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  NEEDS_CLARIFICATION: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  AWAITING_PAYMENT: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  MANUAL_REVIEW: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_TONE[status]}`}
    >
      {status}
    </span>
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
