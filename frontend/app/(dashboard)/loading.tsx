// Shown during navigations into /tickets, /tickets/[id], /workload while
// the Server Component awaits Sheets reads. Tailwind's `animate-pulse`
// keeps it lightweight — no spinner libs.

export default function DashboardLoading() {
  return (
    <div className="space-y-4">
      <div className="h-7 w-40 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-4 w-72 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-32 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-64 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}
