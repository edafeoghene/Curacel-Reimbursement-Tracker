import { cookies } from "next/headers";

import { auth, signOut } from "@/auth";
import { SIDEBAR_COOKIE, SidebarShell } from "@/components/sidebar-shell";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // Read the sidebar-open cookie so the server renders the same initial
  // state the client will hydrate to. Default open when the cookie is
  // missing or anything other than the explicit "0" closed marker.
  const cookieStore = await cookies();
  const initialOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== "0";
  const initialTheme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <SidebarShell
      userEmail={session?.user?.email ?? null}
      signOutAction={handleSignOut}
      initialOpen={initialOpen}
      initialTheme={initialTheme}
    >
      {children}
    </SidebarShell>
  );
}
