// Boot-time reconciliation helper — pure classification only.
// The actual sheet read and any in-memory rebuild happens in the sheets/slack
// layers; this file just decides which tickets need attention on boot.

import type { Ticket, Status } from "@curacel/shared";
import { isTerminalStatus, TICKET_STATUSES } from "@curacel/shared";

/**
 * Statuses that represent in-flight work. On boot, tickets in these states
 * must be re-attached to the runtime so we can re-DM, re-watch payments, etc.
 *
 * Derived from the canonical TICKET_STATUSES + isTerminalStatus so the
 * single source of truth is types.ts and a new status added there fires
 * tsc-time exhaustiveness checks.
 */
export const NON_TERMINAL_STATUSES: readonly Status[] = TICKET_STATUSES.filter(
  (s) => !isTerminalStatus(s),
);

/** True if the status is non-terminal and the ticket is still in flight. */
export function isNonTerminal(status: Status): boolean {
  return !isTerminalStatus(status);
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
