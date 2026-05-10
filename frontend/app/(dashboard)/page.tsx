import Link from "next/link";

import { type Status } from "@curacel/shared";

import { StatusDonutChart } from "@/components/charts/status-donut-chart";
import { WeeklyPaidChart } from "@/components/charts/weekly-paid-chart";
import {
  aggregateByStatus,
  computeKpis,
  formatCurrencyCompact,
  formatCurrencyFull,
  summarizeOtherCurrencies,
  topCategoriesPaidThisMonth,
  weeklyPaid,
  type CategoryTotal,
  type KpiBucket,
} from "@/lib/dashboard/aggregates";
import { listAllTickets } from "@/lib/sheets/tickets";

export const revalidate = 30;

export const metadata = { title: "Home — Curacel Expense Dashboard" };

export default async function DashboardHome() {
  const tickets = await listAllTickets();

  const kpis = computeKpis(tickets);
  const statusAgg = aggregateByStatus(tickets);
  const weekly = weeklyPaid(tickets, 12);
  const topCats = topCategoriesPaidThisMonth(tickets);
  const others = summarizeOtherCurrencies(tickets);
  const recent = tickets.slice(0, 8);

  const weeklyTotal = weekly.reduce((s, p) => s + p.amount, 0);
  const weeklyTicketsTotal = weekly.reduce((s, p) => s + p.count, 0);
  const topCatsAmount = topCats.reduce((s, p) => s + p.amount, 0);

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
        />
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Paid per week</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Last 12 weeks · {formatCurrencyFull(weeklyTotal)} across {weeklyTicketsTotal}{" "}
              {weeklyTicketsTotal === 1 ? "ticket" : "tickets"}
              {" · "}
              <span className="text-zinc-500">YTD {formatCurrencyFull(kpis.paidYTD.amount)}</span>
            </p>
          </div>
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
}: {
  label: string;
  bucket: KpiBucket;
  tone: Tone;
  href: string;
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
    </Link>
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
