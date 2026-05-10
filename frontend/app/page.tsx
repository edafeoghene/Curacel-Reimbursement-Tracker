import { auth, signOut } from "@/auth";

export default async function Home() {
  const session = await auth();

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">Curacel Expense Dashboard</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in as <span className="font-medium">{session?.user?.email ?? "unknown"}</span>.
          Ticket queue and detail views land in the next waves.
        </p>
      </div>
      <form action={handleSignOut}>
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
