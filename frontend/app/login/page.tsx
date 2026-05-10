import { signIn } from "@/auth";

export const metadata = { title: "Sign in — Curacel Expense Dashboard" };

export default function LoginPage() {
  // Server Action that initiates the Google OAuth flow. signIn() in v5
  // takes care of the full redirect dance; we just point it at the
  // provider id ("google") and an optional callbackUrl.
  async function handleSignIn() {
    "use server";
    await signIn("google", { redirectTo: "/" });
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Curacel Expense Dashboard</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Sign in with your Curacel Google account to continue.
        </p>
      </div>
      <form action={handleSignIn}>
        <button
          type="submit"
          className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Sign in with Google
        </button>
      </form>
    </main>
  );
}
