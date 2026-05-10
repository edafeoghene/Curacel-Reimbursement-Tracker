"use client";

// Error boundary for any unhandled exception thrown during a dashboard
// render. The most common cause in practice is the Sheets API being
// unreachable or returning a malformed response. A friendly retry beats
// Next's default "Application error" screen.

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The bot uses bare console.error; mirror that here. Production
    // observability is a Phase 2.x polish item.
    console.error("[dashboard] render error", error);
  }, [error]);

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-6 dark:border-red-900/60 dark:bg-red-950/40">
      <h1 className="text-lg font-semibold text-red-900 dark:text-red-200">
        Something went wrong
      </h1>
      <p className="mt-1 text-sm text-red-800 dark:text-red-300">
        {error.message || "Unknown error rendering this page."}
      </p>
      {error.digest ? (
        <p className="mt-1 font-mono text-xs text-red-700/80 dark:text-red-400/80">
          Reference: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-red-900 px-4 text-sm font-medium text-white transition hover:bg-red-800 dark:bg-red-200 dark:text-red-950 dark:hover:bg-red-100"
      >
        Try again
      </button>
    </div>
  );
}
