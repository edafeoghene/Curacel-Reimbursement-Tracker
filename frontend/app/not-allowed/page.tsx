import Link from "next/link";

export const metadata = { title: "Access denied — Curacel Expense Dashboard" };

export default function NotAllowedPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Access denied</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Your Google account isn&apos;t authorized for this dashboard. If you
          believe this is wrong, ask the admin to add your email to the
          allowlist.
        </p>
      </div>
      <Link
        href="/login"
        className="text-sm font-medium text-zinc-900 underline underline-offset-4 dark:text-zinc-50"
      >
        Try again with a different account
      </Link>
    </main>
  );
}
