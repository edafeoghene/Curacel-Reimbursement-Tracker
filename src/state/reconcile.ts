// Boot-time reconciliation helper — pure classification only.
// The actual sheet read and any in-memory rebuild happens in the sheets/slack
// layers; this file just decides which tickets need attention on boot.

import type { Ticket, Status } from "../types.js";

/**
 * Statuses that represent in-flight work. On boot, tickets in these states
 * must be re-attached to the runtime so we can re-DM, re-watch payments, etc.
 *
 * Derived by exclusion from the terminal set, but kept as an explicit literal
 * so `Status` exhaustiveness checks fire if the enum changes.
 */
export const NON_TERMINAL_STATUSES = [
  "SUBMITTED",
  "AWAITING_APPROVAL",
  "NEEDS_CLARIFICATION",
  "APPROVED",
  "AWAITING_PAYMENT",
  "MANUAL_REVIEW",
] as const satisfies readonly Status[];

const NON_TERMINAL_SET: ReadonlySet<Status> = new Set<Status>(
  NON_TERMINAL_STATUSES,
);

/** True if the status is non-terminal and the ticket is still in flight. */
export function isNonTerminal(status: Status): boolean {
  return NON_TERMINAL_SET.has(status);
}

/**
 * Split a list of tickets into the ones that still need work (`toResume`)
 * and the ones that are already settled (`terminal` — PAID/REJECTED/CANCELLED).
 * Order within each bucket follows the input order so callers can reason
 * about created_at / route_id ordering after partitioning.
 */
export function partitionForReconciliation(tickets: Ticket[]): {
  toResume: Ticket[];
  terminal: Ticket[];
} {
  const toResume: Ticket[] = [];
  const terminal: Ticket[] = [];
  for (const t of tickets) {
    if (isNonTerminal(t.status)) {
      toResume.push(t);
    } else {
      terminal.push(t);
    }
  }
  return { toResume, terminal };
}
