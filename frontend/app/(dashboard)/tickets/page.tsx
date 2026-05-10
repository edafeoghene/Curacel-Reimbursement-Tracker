import Link from "next/link";

import { TICKET_STATUSES, type Status, type Ticket } from "@curacel/shared";

import { DatePicker } from "@/components/date-picker";
import { RefreshButton } from "@/components/refresh-button";
import {
  applyTicketFilters,
  listAllTickets,
  type TicketListFilters,
} from "@/lib/sheets/tickets";

// SSR + 30s revalidation: tickets data is small and rarely-changing, so
// SSR with revalidate is much simpler than client-side polling. The
// "Refresh" button below also does an explicit revalidatePath.
export const revalidate = 30;

export const metadata = { title: "Tickets — Curacel Expense Dashboard" };

const PAGE_SIZE = 20;

interface RawSearchParams {
  status?: string | string[];
  requester?: string | string[];
  route?: string | string[];
  from?: string | string[];
  to?: string | string[];
  page?: string | string[];
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isStatus(v: string | undefined): v is Status {
  return v !== undefined && (TICKET_STATUSES as readonly string[]).includes(v);
}

function parseFilters(raw: RawSearchParams): TicketListFilters {
  const status = firstString(raw.status);
  return {
    status: isStatus(status) ? status : undefined,
    requesterUserId: firstString(raw.requester) || undefined,
    routeId: firstString(raw.route) || undefined,
    createdFrom: firstString(raw.from) || undefined,
    createdTo: firstString(raw.to) || undefined,
  };
}

function parsePage(raw: RawSearchParams): number {
  const p = Number(firstString(raw.page) ?? 1);
  return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v.length > 0) sp.set(k, v);
  }
  const s = sp.toString();
  return s.length === 0 ? "" : `?${s}`;
}

function pageUrl(filters: TicketListFilters, page: number): string {
  return `/tickets${buildQueryString({
    status: filters.status,
    requester: filters.requesterUserId,
    route: filters.routeId,
    from: filters.createdFrom,
    to: filters.createdTo,
    page: page > 1 ? String(page) : undefined,
  })}`;
}

async function refreshAction() {
  "use server";
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/tickets");
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const filters = parseFilters(raw);
  const page = parsePage(raw);

  // Single Sheets read; we filter for display in JS AND derive the
  // dropdown options (routes, requesters) from the same dataset.
  // Avoids extra sheet reads for the dropdown lists.
  const everything = await listAllTickets();
  const all = applyTicketFilters(everything, filters);
  const distinctRoutes = Array.from(
    new Set(everything.map((t) => t.route_id).filter((r): r is string => Boolean(r))),
  ).sort();
  const distinctRequesters = collectRequesters(everything);

  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const slice = all.slice(start, start + PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {all.length} {all.length === 1 ? "ticket" : "tickets"} match.
          </p>
        </div>
        <form action={refreshAction}>
          <RefreshButton />
        </form>
      </div>

      <FiltersForm filters={filters} routes={distinctRoutes} requesters={distinctRequesters} />

      {slice.length === 0 ? (
        <EmptyState hasFilters={hasAnyFilter(filters)} />
      ) : (
        <>
          <TicketsTable rows={slice} />
          <Pagination
            page={safePage}
            totalPages={totalPages}
            filters={filters}
          />
        </>
      )}
    </div>
  );
}

function hasAnyFilter(f: TicketListFilters): boolean {
  return Boolean(
    f.status || f.requesterUserId || f.routeId || f.createdFrom || f.createdTo,
  );
}

interface RequesterOption {
  userId: string;
  name: string;
}

/**
 * Build a sorted (by display name) list of distinct requesters from the
 * full ticket set. When a user_id appears across multiple tickets with
 * different names (e.g. a Slack display-name change), we keep the name
 * from the most recently created ticket — the most current label.
 * Falls back to the user_id when no name is on record.
 */
function collectRequesters(tickets: readonly Ticket[]): RequesterOption[] {
  const byId = new Map<string, { name: string; lastSeen: string }>();
  for (const t of tickets) {
    if (!t.requester_user_id) continue;
    const existing = byId.get(t.requester_user_id);
    if (!existing || t.created_at > existing.lastSeen) {
      byId.set(t.requester_user_id, {
        name: t.requester_name || t.requester_user_id,
        lastSeen: t.created_at,
      });
    }
  }
  return Array.from(byId.entries())
    .map(([userId, { name }]) => ({ userId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function FiltersForm({
  filters,
  routes,
  requesters,
}: {
  filters: TicketListFilters;
  routes: string[];
  requesters: RequesterOption[];
}) {
  // Explicit grid (not flex-wrap) so the column breakpoints are
  // predictable and the Apply/Clear buttons land in a known position
  // at every width. On lg+ the 5 fields share equal-fraction columns
  // and the buttons take an auto-sized cell at the end of the row;
  // below lg, the buttons span all columns and sit beneath the fields.
  return (
    <form
      method="GET"
      action="/tickets"
      className="grid grid-cols-1 gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] dark:border-zinc-800 dark:bg-zinc-900"
    >
      <Field label="Status">
        <select
          name="status"
          defaultValue={filters.status ?? ""}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Requester">
        <select
          name="requester"
          defaultValue={filters.requesterUserId ?? ""}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <option value="">All requesters</option>
          {requesters.map((r) => (
            <option key={r.userId} value={r.userId}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Route">
        <select
          name="route"
          defaultValue={filters.routeId ?? ""}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <option value="">All routes</option>
          {routes.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From (created)">
        <DatePicker
          name="from"
          defaultValue={filters.createdFrom ?? ""}
          placeholder="Any date"
          ariaLabel="Filter by created-from date"
        />
      </Field>
      <Field label="To (created)">
        <DatePicker
          name="to"
          defaultValue={filters.createdTo ?? ""}
          placeholder="Any date"
          ariaLabel="Filter by created-to date"
        />
      </Field>
      <div className="col-span-full flex items-center justify-end gap-2 sm:col-span-2 lg:col-span-1 lg:self-end lg:pb-px">
        <Link
          href="/tickets"
          className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          Clear
        </Link>
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 ${className ?? ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function TicketsTable({ rows }: { rows: Ticket[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-2 font-medium">Tracking ID</th>
            <th className="px-4 py-2 font-medium">Created</th>
            <th className="px-4 py-2 font-medium">Requester</th>
            <th className="px-4 py-2 font-medium">Description</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Route</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((t) => (
            <tr key={t.tracking_id} className="bg-white hover:bg-zinc-50 dark:bg-zinc-950 dark:hover:bg-zinc-900">
              <td className="px-4 py-2 font-mono text-xs">
                <Link
                  href={`/tickets/${encodeURIComponent(t.tracking_id)}`}
                  className="text-zinc-900 hover:underline dark:text-zinc-50"
                >
                  {t.tracking_id}
                </Link>
              </td>
              <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                {formatDate(t.created_at)}
              </td>
              <td className="px-4 py-2">{t.requester_name}</td>
              <td className="max-w-md truncate px-4 py-2">{t.description}</td>
              <td className="px-4 py-2 text-right font-mono">
                {t.currency} {t.amount.toLocaleString()}
              </td>
              <td className="px-4 py-2">
                <StatusBadge status={t.status} />
              </td>
              <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {t.route_id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const tone = STATUS_TONES[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

const STATUS_TONES: Record<Status, string> = {
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

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-200 p-12 text-center dark:border-zinc-800">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {hasFilters
          ? "No tickets match these filters. Try clearing them or adjusting the date range."
          : "No tickets in the workbook yet. Submit one in the #expenses Slack channel."}
      </p>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  filters,
}: {
  page: number;
  totalPages: number;
  filters: TicketListFilters;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-600 dark:text-zinc-400">
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={pageUrl(filters, page - 1)}
            className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={pageUrl(filters, page + 1)}
            className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
