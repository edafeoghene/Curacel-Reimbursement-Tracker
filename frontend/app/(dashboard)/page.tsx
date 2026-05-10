import Link from "next/link";

import { TICKET_STATUSES, type Status, type Ticket } from "@curacel/shared";

import { listAllTickets } from "@/lib/sheets/tickets";

export const revalidate = 30;

export const metadata = { title: "Home — Curacel Expense Dashboard" };

export default async function DashboardHome() {
  const tickets = await listAllTickets();

  const counts = countByStatus(tickets);
  const paidThisMonth = countPaidThisMonth(tickets);
  const recent = tickets.slice(0, 8);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {tickets.length === 0
            ? "No tickets in the workbook yet."
            : `${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"} in the workbook.`}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Awaiting approval"
          value={counts.AWAITING_APPROVAL}
          tone="amber"
          href="/tickets?status=AWAITING_APPROVAL"
        />
        <KpiCard
          label="Awaiting payment"
          value={counts.AWAITING_PAYMENT}
          tone="violet"
          href="/tickets?status=AWAITING_PAYMENT"
        />
        <KpiCard
          label="Manual review"
          value={counts.MANUAL_REVIEW}
          tone="pink"
          href="/tickets?status=MANUAL_REVIEW"
        />
        <KpiCard
          label="Paid this month"
          value={paidThisMonth}
          tone="emerald"
          href="/tickets?status=PAID"
        />
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Status breakdown</h2>
          <span className="text-xs text-zinc-500">{tickets.length} total</span>
        </div>
        <ul className="mt-4 space-y-2">
          {breakdown(counts, tickets.length).map(({ status, count, percent }) => (
            <li key={status} className="grid grid-cols-[180px_1fr_56px] items-center gap-3 text-sm">
              <Link
                href={`/tickets?status=${status}`}
                className="font-mono text-xs text-zinc-700 hover:underline dark:text-zinc-300"
              >
                {status}
              </Link>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                <div
                  className={`h-full rounded-full ${STATUS_BAR_TONE[status]}`}
                  style={{ width: `${Math.max(percent, count > 0 ? 2 : 0)}%` }}
                />
              </div>
              <span className="text-right tabular-nums text-zinc-600 dark:text-zinc-400">{count}</span>
            </li>
          ))}
        </ul>
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

// ---------- helpers ----------

function countByStatus(tickets: readonly Ticket[]): Record<Status, number> {
  const out = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const t of tickets) out[t.status] += 1;
  return out;
}

function countPaidThisMonth(tickets: readonly Ticket[]): number {
  const now = new Date();
  const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let n = 0;
  for (const t of tickets) {
    if (t.status === "PAID" && (t.updated_at ?? "").startsWith(prefix)) n += 1;
  }
  return n;
}

function breakdown(counts: Record<Status, number>, total: number) {
  return TICKET_STATUSES.map((status) => ({
    status,
    count: counts[status],
    percent: total === 0 ? 0 : (counts[status] / total) * 100,
  })).sort((a, b) => b.count - a.count);
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
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: Tone;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={`group rounded-md border p-4 transition hover:shadow-sm ${KPI_TONES[tone]}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
    </Link>
  );
}

const STATUS_BAR_TONE: Record<Status, string> = {
  SUBMITTED: "bg-zinc-400 dark:bg-zinc-600",
  AWAITING_APPROVAL: "bg-amber-500",
  NEEDS_CLARIFICATION: "bg-orange-500",
  APPROVED: "bg-blue-500",
  AWAITING_PAYMENT: "bg-violet-500",
  PAID: "bg-emerald-500",
  REJECTED: "bg-red-500",
  CANCELLED: "bg-zinc-400 dark:bg-zinc-600",
  MANUAL_REVIEW: "bg-pink-500",
};

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
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_TONE[status]}`}>
      {status}
    </span>
  );
}
