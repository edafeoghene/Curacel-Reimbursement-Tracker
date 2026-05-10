// Single source of truth for every status-themed color in the UI.
// Previously these tables existed in four files (homepage KPI helper,
// homepage StatusBadge, queue StatusBadge, detail StatusBadge) and a
// fifth (donut hex codes). Visual drift was a matter of time — change
// one, miss the others.
//
// Anything that needs to color-code a Status reads from here.

import type { Status } from "@curacel/shared";

/**
 * Tailwind class string for a pill/badge rendering of a status. Includes
 * background + text + dark-mode variants. Used by <StatusBadge>.
 */
export const STATUS_BADGE_CLASSES: Record<Status, string> = {
  SUBMITTED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  AWAITING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  NEEDS_CLARIFICATION: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  AWAITING_PAYMENT: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  MANUAL_REVIEW: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

/**
 * Tailwind class string for the solid-fill BAR variant (the
 * status-breakdown chart on the homepage). Brighter than the badge tone
 * so the bars are readable when small.
 */
export const STATUS_BAR_CLASSES: Record<Status, string> = {
  SUBMITTED: "bg-zinc-400 dark:bg-zinc-600",
  AWAITING_APPROVAL: "bg-amber-500",
  NEEDS_CLARIFICATION: "bg-orange-500",
  APPROVED: "bg-blue-500",
  AWAITING_PAYMENT: "bg-violet-500",
  PAID: "bg-emerald-500",
  REJECTED: "bg-red-500",
  CANCELLED: "bg-zinc-400 dark:bg-zinc-600",
  MANUAL_REVIEW: "bg-pink-500",
};

/**
 * Raw hex values for SVG / canvas chart fills where Tailwind classes
 * can't be passed (Recharts' inline fill prop, etc.). These intentionally
 * match the -500 shade used in STATUS_BAR_CLASSES so a status looks the
 * same whether rendered as a div-bar or a chart slice.
 */
export const STATUS_HEX: Record<Status, string> = {
  SUBMITTED: "#a1a1aa",
  AWAITING_APPROVAL: "#f59e0b",
  NEEDS_CLARIFICATION: "#f97316",
  APPROVED: "#3b82f6",
  AWAITING_PAYMENT: "#8b5cf6",
  PAID: "#10b981",
  REJECTED: "#ef4444",
  CANCELLED: "#71717a",
  MANUAL_REVIEW: "#ec4899",
};
