"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  formatCurrencyCompact,
  formatCurrencyFull,
  type WeeklyPaidPoint,
} from "@/lib/dashboard/aggregates";

interface Props {
  data: WeeklyPaidPoint[];
}

export function WeeklyPaidChart({ data }: Props) {
  const total = data.reduce((s, p) => s + p.amount, 0);
  const ticketsTotal = data.reduce((s, p) => s + p.count, 0);
  // Screen-reader equivalent of "glance at the bar chart": total spent
  // across the window plus the per-week sequence. AT users get the same
  // information sighted users get from the bars.
  const ariaLabel =
    `Bar chart of NGN paid per week across ${data.length} weeks. ` +
    `Total: ${formatCurrencyFull(total)} across ${ticketsTotal} ${
      ticketsTotal === 1 ? "ticket" : "tickets"
    }. ` +
    data.map((p) => `${p.weekLabel}: ${formatCurrencyFull(p.amount)}`).join("; ") +
    ".";

  return (
    <div className="h-64 w-full" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="2 4"
            stroke="rgb(228 228 231)"
            className="dark:stroke-zinc-800"
            vertical={false}
          />
          <XAxis
            dataKey="weekLabel"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "rgb(113 113 122)", fontSize: 11 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: "rgb(113 113 122)", fontSize: 11 }}
            tickFormatter={(v: number) =>
              formatCurrencyCompact(v).replace(/^NGN\s/, "")
            }
            width={48}
          />
          <Tooltip
            cursor={{ fill: "rgba(16, 185, 129, 0.08)" }}
            content={<CustomTooltip />}
          />
          <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadItem {
  payload: WeeklyPaidPoint;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <p className="font-medium">Week of {point.weekLabel}</p>
      <p className="mt-0.5 font-mono text-zinc-700 dark:text-zinc-300">
        {formatCurrencyFull(point.amount)}
      </p>
      <p className="text-zinc-500">
        {point.count} {point.count === 1 ? "ticket" : "tickets"} paid
      </p>
    </div>
  );
}
