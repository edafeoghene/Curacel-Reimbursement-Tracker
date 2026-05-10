import { describe, expect, it } from "vitest";
import { resolveRoute } from "../../src/state/routing.js";
import type { Route } from "@curacel/shared";

const NGN_ROUTES: Route[] = [
  {
    route_id: "low-ngn",
    currency: "NGN",
    min_amount: 0,
    max_amount: 50000,
    category_filter: [],
    approvers: ["U_STEPHAN"],
  },
  {
    route_id: "mid-ngn",
    currency: "NGN",
    min_amount: 50000,
    max_amount: 500000,
    category_filter: [],
    approvers: ["U_PATRICK", "U_STEPHAN"],
  },
  {
    route_id: "high-ngn",
    currency: "NGN",
    min_amount: 500000,
    max_amount: null,
    category_filter: [],
    approvers: ["U_PATRICK", "U_TINUS", "U_STEPHAN"],
  },
];

describe("resolveRoute: amount banding", () => {
  it("picks low-ngn for amounts in [0, 50000)", () => {
    expect(resolveRoute(NGN_ROUTES, 0, "NGN", "equipment")?.route_id).toBe(
      "low-ngn",
    );
    expect(resolveRoute(NGN_ROUTES, 49999, "NGN", "equipment")?.route_id).toBe(
      "low-ngn",
    );
  });

  it("picks mid-ngn for [50000, 500000) — boundary is exclusive on max", () => {
    expect(resolveRoute(NGN_ROUTES, 50000, "NGN", "equipment")?.route_id).toBe(
      "mid-ngn",
    );
    expect(
      resolveRoute(NGN_ROUTES, 499999, "NGN", "equipment")?.route_id,
    ).toBe("mid-ngn");
  });

  it("picks high-ngn for >= 500000 (no upper bound)", () => {
    expect(
      resolveRoute(NGN_ROUTES, 500000, "NGN", "equipment")?.route_id,
    ).toBe("high-ngn");
    expect(
      resolveRoute(NGN_ROUTES, 1_000_000_000, "NGN", "equipment")?.route_id,
    ).toBe("high-ngn");
  });
});

describe("resolveRoute: currency", () => {
  it("returns null when no route's currency matches", () => {
    expect(resolveRoute(NGN_ROUTES, 1000, "USD", "equipment")).toBeNull();
  });

  it("currency match is case-sensitive (ISO 4217 is upper-case)", () => {
    expect(resolveRoute(NGN_ROUTES, 1000, "ngn", "equipment")).toBeNull();
  });
});

describe("resolveRoute: category filter", () => {
  const FILTERED: Route[] = [
    {
      route_id: "travel-only",
      currency: "NGN",
      min_amount: 0,
      max_amount: null,
      category_filter: ["travel", "transport"],
      approvers: ["U_TRAVEL_LEAD"],
    },
    {
      route_id: "fallback",
      currency: "NGN",
      min_amount: 0,
      max_amount: null,
      category_filter: [],
      approvers: ["U_STEPHAN"],
    },
  ];

  it("matches when category is in the filter", () => {
    expect(resolveRoute(FILTERED, 100, "NGN", "travel")?.route_id).toBe(
      "travel-only",
    );
    expect(resolveRoute(FILTERED, 100, "NGN", "transport")?.route_id).toBe(
      "travel-only",
    );
  });

  it("falls through to the next route when category is not in the filter", () => {
    expect(resolveRoute(FILTERED, 100, "NGN", "equipment")?.route_id).toBe(
      "fallback",
    );
  });

  it("empty category filter matches all categories", () => {
    expect(resolveRoute(FILTERED, 100, "NGN", "anything")?.route_id).toBe(
      "fallback",
    );
  });
});

describe("resolveRoute: ordering / first-match-wins", () => {
  it("returns the FIRST matching route in input order, not the most specific", () => {
    const overlapping: Route[] = [
      {
        route_id: "catch-all",
        currency: "NGN",
        min_amount: 0,
        max_amount: null,
        category_filter: [],
        approvers: ["U_A"],
      },
      {
        route_id: "specific",
        currency: "NGN",
        min_amount: 0,
        max_amount: 100,
        category_filter: ["meals"],
        approvers: ["U_B"],
      },
    ];
    // The catch-all comes first → it wins, even though "specific" also matches.
    expect(resolveRoute(overlapping, 50, "NGN", "meals")?.route_id).toBe(
      "catch-all",
    );
  });

  it("preserves order between currencies", () => {
    const mixed: Route[] = [
      {
        route_id: "usd-only",
        currency: "USD",
        min_amount: 0,
        max_amount: null,
        category_filter: [],
        approvers: ["U_USD"],
      },
      ...NGN_ROUTES,
    ];
    expect(resolveRoute(mixed, 1000, "NGN", "equipment")?.route_id).toBe(
      "low-ngn",
    );
    expect(resolveRoute(mixed, 1000, "USD", "equipment")?.route_id).toBe(
      "usd-only",
    );
  });
});

describe("resolveRoute: edge cases", () => {
  it("returns null on empty routes list", () => {
    expect(resolveRoute([], 100, "NGN", "equipment")).toBeNull();
  });

  it("does not throw on zero amount", () => {
    expect(() =>
      resolveRoute(NGN_ROUTES, 0, "NGN", "equipment"),
    ).not.toThrow();
  });

  it("does not throw on negative amount (returns null since 0 is min)", () => {
    expect(resolveRoute(NGN_ROUTES, -5, "NGN", "equipment")).toBeNull();
  });

  it("does not throw on empty category string (treated as no-match for filtered routes)", () => {
    const filtered: Route[] = [
      {
        route_id: "transport-only",
        currency: "NGN",
        min_amount: 0,
        max_amount: null,
        category_filter: ["transport"],
        approvers: ["U_X"],
      },
    ];
    expect(resolveRoute(filtered, 100, "NGN", "")).toBeNull();
  });
});
