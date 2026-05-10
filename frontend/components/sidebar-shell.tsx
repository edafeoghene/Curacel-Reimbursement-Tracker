"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { NavLink } from "./nav-link";

export const SIDEBAR_COOKIE = "curacel-sidebar-open";

interface Props {
  userEmail: string | null;
  signOutAction: () => Promise<void>;
  initialOpen: boolean;
  children: React.ReactNode;
}

export function SidebarShell({ userEmail, signOutAction, initialOpen, children }: Props) {
  const [open, setOpen] = useState(initialOpen);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      // Persist client-side (instant) + via cookie so the server renders
      // the right initial state on the next hard reload (no flash).
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      return next;
    });
  }

  return (
    <div className="min-h-svh">
      {/* Mobile top bar (always shown <md). Sidebar collapse is a desktop
          concern; mobile keeps the top bar visible at all times. */}
      <header className="border-b border-zinc-200 bg-white md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/curacel-logo.png"
              alt="Curacel"
              width={28}
              height={28}
              priority
            />
            <span className="text-sm font-semibold tracking-tight">Expense</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <NavLink href="/" variant="topbar">Home</NavLink>
            <NavLink href="/tickets" variant="topbar">Tickets</NavLink>
            <NavLink href="/workload" variant="topbar">Workload</NavLink>
          </nav>
        </div>
      </header>

      {/* Desktop sidebar — fixed-position rail. Slides off-screen when
          closed via translate-x; stays in the DOM so the transition is
          smooth both ways. */}
      <aside
        className={`hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col md:border-r md:border-zinc-200 md:bg-white md:px-4 md:py-6 md:transition-transform md:duration-200 dark:md:border-zinc-800 dark:md:bg-zinc-950 ${
          open ? "md:translate-x-0" : "md:-translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-start justify-between gap-2">
          <Link href="/" className="flex items-center gap-3 px-3">
            <Image
              src="/curacel-logo.png"
              alt="Curacel"
              width={36}
              height={36}
              priority
            />
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight">Curacel</p>
              <p className="text-xs leading-tight text-zinc-500">Expense Dashboard</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label="Close sidebar"
            className="-mr-1 mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          <NavLink href="/">Home</NavLink>
          <NavLink href="/tickets">Tickets</NavLink>
          <NavLink href="/workload">Workload</NavLink>
        </nav>

        <div className="mt-auto space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p
            className="truncate px-3 text-xs text-zinc-600 dark:text-zinc-400"
            title={userEmail ?? "unknown"}
          >
            {userEmail ?? "unknown"}
          </p>
          <form action={signOutAction} className="px-3">
            <button
              type="submit"
              className="inline-flex h-8 w-full items-center justify-center rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Floating "open sidebar" button. Only on desktop, only visible when
          the sidebar is closed. Opacity transition matches the slide. */}
      <button
        type="button"
        onClick={toggle}
        aria-label="Open sidebar"
        className={`fixed left-4 top-4 z-20 hidden md:inline-flex md:h-9 md:w-9 md:items-center md:justify-center md:rounded-md md:border md:border-zinc-200 md:bg-white md:text-zinc-700 md:shadow-sm md:transition-opacity dark:md:border-zinc-800 dark:md:bg-zinc-950 dark:md:text-zinc-300 ${
          open ? "md:pointer-events-none md:opacity-0" : "md:opacity-100"
        }`}
        tabIndex={open ? -1 : 0}
      >
        <MenuIcon />
      </button>

      <main
        className={`px-4 py-6 md:py-10 md:transition-[margin-left,padding] md:duration-200 ${
          open ? "md:ml-64 md:px-8" : "md:ml-0 md:px-16"
        }`}
      >
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Mobile-only secondary footer for sign-out + email — the mobile
          top bar is too cramped to fit them inline. */}
      <footer className="border-t border-zinc-200 bg-white px-4 py-3 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span
            className="truncate text-zinc-600 dark:text-zinc-400"
            title={userEmail ?? "unknown"}
          >
            {userEmail ?? "unknown"}
          </span>
          <form action={signOutAction}>
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3l10 10M13 3L3 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3 5h12M3 9h12M3 13h12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
