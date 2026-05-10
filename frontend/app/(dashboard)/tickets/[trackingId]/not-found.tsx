import Link from "next/link";

export default function TicketNotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <Link
        href="/tickets"
        className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
      >
        ← All tickets
      </Link>
      <div className="rounded-md border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold">Ticket not found</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          That tracking ID doesn&apos;t exist in the workbook. Check the link
          or pick a different ticket from the queue.
        </p>
      </div>
    </div>
  );
}
