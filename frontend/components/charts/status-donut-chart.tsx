"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { Status } from "@curacel/shared";

import {
  formatCurrencyFull,
  type StatusAggregate,
} from "@/lib/dashboard/aggregates";

interface Props {
  data: StatusAggregate[];
}

const STATUS_FILLS: Record<Status, string> = {
  SUBMITTED: "#a1a1aa",
  AWAITING_APPROVAL: "#f59e0b",
  NEEDS_CLARIFICATION: "#f97316",
  APPROVED: "#3b82f6",
  AWAITING_PAYMENT: "#8b5cf6",
  PAID: "#10b981",
  REJECTED: "#ef4444",
  CANCELLED: "#71717a",
  MANUAL_REVIEW: "#ec4899",
};

export function StatusDonutChart({ data }: Props) {
  const visible = data.filter((s) => s.count > 0);
  const total = visible.reduce((s, x) => s + x.count, 0);

  if (total === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No tickets yet.
      </div>
    );
  }

  return (
    <div className="grid items-center gap-6 sm:grid-cols-[220px_1fr]">
      <div className="relative h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={visible}
              dataKey="count"
              nameKey="status"
              innerRadius={56}
              outerRadius={88}
              paddingAngle={1}
              stroke="none"
            >
              {visible.map((entry) => (
                <Cell key={entry.status} fill={STATUS_FILLS[entry.status]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">{total}</span>
          <span className="text-xs uppercase tracking-wide text-zinc-500">tickets</span>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm">
        {visible
          .slice()
          .sort((a, b) => b.count - a.count)
          .map((s) => (
            <li key={s.status} className="grid grid-cols-[10px_1fr_auto_auto] items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: STATUS_FILLS[s.status] }}
              />
              <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {s.status}
              </span>
              <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{s.count}</span>
              <span className="font-mono text-xs tabular-nums text-zinc-500">
                {formatCurrencyFull(s.amount)}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

interface TooltipPayloadItem {
  payload: StatusAggregate;
}

function CustomTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  total: number;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const percent = total > 0 ? Math.round((point.count / total) * 100) : 0;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <p className="font-mono font-medium">{point.status}</p>
      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">
        {point.count} {point.count === 1 ? "ticket" : "tickets"} ({percent}%)
      </p>
      <p className="font-mono text-zinc-500">{formatCurrencyFull(point.amount)}</p>
    </div>
  );
}
