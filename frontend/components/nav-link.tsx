"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  href: string;
  children: React.ReactNode;
  /**
   * Optional layout override. Sidebar links want full-width row styling;
   * the mobile top-bar variant is a compact inline link. Pass either
   * "sidebar" (default) or "topbar".
   */
  variant?: "sidebar" | "topbar";
}

/**
 * A tiny client component that highlights itself when its href matches
 * the current pathname. Living in /components/nav-link.tsx so the
 * server-rendered layout can stay a Server Component (which gives it
 * access to `auth()` for the user email + sign-out action).
 */
export function NavLink({ href, children, variant = "sidebar" }: Props) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  if (variant === "topbar") {
    return (
      <Link
        href={href}
        className={
          active
            ? "text-zinc-900 dark:text-zinc-50"
            : "text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        }
      >
        {children}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={
        active
          ? "block rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50"
          : "block rounded-md px-3 py-1.5 text-sm text-zinc-600 transition hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
      }
    >
      {children}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
