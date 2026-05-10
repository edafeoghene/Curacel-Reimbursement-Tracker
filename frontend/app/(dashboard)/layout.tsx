import Link from "next/link";

import { auth, signOut } from "@/auth";
import { NavLink } from "@/components/nav-link";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="min-h-svh">
      {/* Mobile top bar — only visible below md. Sidebars eat too much
          horizontal space on phones, so we fall back to a compact strip. */}
      <header className="border-b border-zinc-200 bg-white md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Curacel Expense
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <NavLink href="/" variant="topbar">Home</NavLink>
            <NavLink href="/tickets" variant="topbar">Tickets</NavLink>
            <NavLink href="/workload" variant="topbar">Workload</NavLink>
          </nav>
        </div>
      </header>

      {/* Desktop sidebar — fixed-position rail. md:ml-64 on <main> below
          leaves space for it. */}
      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-64 md:flex-col md:border-r md:border-zinc-200 md:bg-white md:px-4 md:py-6 dark:md:border-zinc-800 dark:md:bg-zinc-950">
        <Link href="/" className="px-3">
          <p className="text-sm font-semibold tracking-tight">Curacel</p>
          <p className="text-xs text-zinc-500">Expense Dashboard</p>
        </Link>

        <nav className="mt-8 flex flex-col gap-1">
          <NavLink href="/">Home</NavLink>
          <NavLink href="/tickets">Tickets</NavLink>
          <NavLink href="/workload">Workload</NavLink>
        </nav>

        <div className="mt-auto space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p
            className="truncate px-3 text-xs text-zinc-600 dark:text-zinc-400"
            title={session?.user?.email ?? "unknown"}
          >
            {session?.user?.email ?? "unknown"}
          </p>
          <form action={handleSignOut} className="px-3">
            <button
              type="submit"
              className="inline-flex h-8 w-full items-center justify-center rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="px-4 py-6 md:ml-64 md:px-8 md:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Mobile-only secondary footer for the sign-out + email. The mobile
          top bar above is too cramped to fit them inline. */}
      <footer className="border-t border-zinc-200 bg-white px-4 py-3 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span
            className="truncate text-zinc-600 dark:text-zinc-400"
            title={session?.user?.email ?? "unknown"}
          >
            {session?.user?.email ?? "unknown"}
          </span>
          <form action={handleSignOut}>
            <button
              type="submit"
              className="inline-flex h-7 items-center justify-center rounded-md border border-zinc-200 bg-white px-2.5 font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </footer>
    </div>
  );
}
