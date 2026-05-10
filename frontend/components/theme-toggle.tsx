"use client";

import { useState } from "react";

import { THEME_COOKIE, type Theme } from "@/lib/theme";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface Props {
  initialTheme: Theme;
}

/**
 * Three-state theme toggle: System / Light / Dark. State persists via
 * the `curacel-theme` cookie so the server sets the right `.dark` class
 * on <html> on the next render (no flash on hard reload). The cookie's
 * absence means "system" — the inline script in app/layout.tsx applies
 * prefers-color-scheme then.
 *
 * Class strategy: we only ever add/remove `.dark` on <html>. Light mode
 * is the default :root values; no `.light` class needed.
 */
export function ThemeToggle({ initialTheme }: Props) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  function apply(next: Theme) {
    setTheme(next);
    const root = document.documentElement;
    root.classList.remove("dark");

    if (next === "system") {
      // Clear the cookie so subsequent renders fall through to the
      // prefers-color-scheme branch.
      document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        root.classList.add("dark");
      }
      return;
    }

    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    if (next === "dark") root.classList.add("dark");
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex w-full overflow-hidden rounded-md border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
    >
      <ToggleButton
        active={theme === "system"}
        onClick={() => apply("system")}
        label="System theme"
      >
        <SystemIcon />
      </ToggleButton>
      <ToggleButton
        active={theme === "light"}
        onClick={() => apply("light")}
        label="Light theme"
      >
        <SunIcon />
      </ToggleButton>
      <ToggleButton
        active={theme === "dark"}
        onClick={() => apply("dark")}
        label="Dark theme"
      >
        <MoonIcon />
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={
        active
          ? "flex-1 bg-zinc-900 px-2 py-1.5 text-white transition dark:bg-zinc-50 dark:text-zinc-900"
          : "flex-1 px-2 py-1.5 transition hover:bg-zinc-50 dark:hover:bg-zinc-900"
      }
    >
      <span className="inline-flex h-4 w-full items-center justify-center">{children}</span>
    </button>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="11" height="8" rx="1.5" stroke="currentColor" />
      <path d="M5 12h4M7 10v2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2.5" stroke="currentColor" />
      <path
        d="M7 1.5V2M7 12v.5M1.5 7H2M12 7h.5M2.95 2.95l.35.35M10.7 10.7l.35.35M2.95 11.05l.35-.35M10.7 3.3l.35-.35"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M12 8.5a5 5 0 1 1-6.5-6.5 4 4 0 0 0 6.5 6.5z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}
