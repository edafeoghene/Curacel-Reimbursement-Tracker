"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit-button for the Refresh form. useFormStatus() reads the pending
 * state of the parent <form>'s server action so we can show a spinner /
 * disabled state during the Sheets re-read (usually 1–3s). Must live in
 * a Client Component and be a child of the <form>.
 */
export function RefreshButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
    >
      {pending ? (
        <>
          <Spinner />
          Refreshing…
        </>
      ) : (
        "Refresh"
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
