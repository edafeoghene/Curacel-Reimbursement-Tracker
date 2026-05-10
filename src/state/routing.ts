// Pure route resolution. Picks the first route in input order whose
// predicates match (currency, amount band, optional category filter).
//
// Phase 1.0 lookup; the routes list is loaded by the sheets layer in the
// order they appear in the `routes` tab. This function MUST preserve that
// order — first match wins so ops can rely on row order to express priority.

import type { Route } from "@curacel/shared";

/**
 * Return the first route from `routes` that matches the (amount, currency,
 * category) tuple, or `null` if nothing matches. Never throws.
 *
 * Match rules (PLAN.md §9):
 *   - currency must equal the route's currency (case-sensitive ISO 4217)
 *   - min_amount <= amount
 *   - max_amount === null  OR  amount < max_amount  (max is exclusive)
 *   - category_filter empty  OR  includes the ticket's category
 */
export function resolveRoute(
  routes: Route[],
  amount: number,
  currency: string,
  category: string,
): Route | null {
  for (const route of routes) {
    if (route.currency !== currency) continue;
    if (amount < route.min_amount) continue;
    if (route.max_amount !== null && amount >= route.max_amount) continue;
    if (
      route.category_filter.length > 0 &&
      !route.category_filter.includes(category)
    ) {
      continue;
    }
    return route;
  }
  return null;
}
