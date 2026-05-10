import Link from "next/link";

import type { Approval } from "@curacel/shared";

import { listPendingApprovals } from "@/lib/sheets/approvals";

export const revalidate = 30;

export const metadata = { title: "Workload — Curacel Expense Dashboard" };

interface ApproverRow {
  approverUserId: string;
  approverName: string;
  pendingCount: number;
  trackingIds: string[];
}

function groupByApprover(approvals: Approval[]): ApproverRow[] {
  const byUser = new Map<string, ApproverRow>();
  for (const a of approvals) {
    const existing = byUser.get(a.approver_user_id);
    if (existing) {
      existing.pendingCount += 1;
      existing.trackingIds.push(a.tracking_id);
      // Preserve the freshest non-empty name we've seen.
      if (!existing.approverName && a.approver_name) {
        existing.approverName = a.approver_name;
      }
    } else {
      byUser.set(a.approver_user_id, {
        approverUserId: a.approver_user_id,
        approverName: a.approver_name,
        pendingCount: 1,
        trackingIds: [a.tracking_id],
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.pendingCount - a.pendingCount);
}

export default async function WorkloadPage() {
  const pending = await listPendingApprovals();
  const rows = groupByApprover(pending);
  const totalPending = pending.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workload</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {totalPending === 0
            ? "Nothing waiting on anyone right now."
            : `${totalPending} pending ${totalPending === 1 ? "approval" : "approvals"} across ${rows.length} ${rows.length === 1 ? "approver" : "approvers"}.`}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-12 text-center dark:border-zinc-800">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            All caught up. New tickets will appear here as they arrive.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ApproverCard key={row.approverUserId} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApproverCard({ row }: { row: ApproverRow }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-medium">{row.approverName || row.approverUserId}</p>
          <p className="font-mono text-xs text-zinc-500">{row.approverUserId}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-sm font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {row.pendingCount} pending
        </span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {row.trackingIds.map((id) => (
          <li key={id}>
            <Link
              href={`/tickets/${encodeURIComponent(id)}`}
              className="inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-xs text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {id}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
