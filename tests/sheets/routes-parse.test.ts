import { describe, expect, it } from "vitest";
import {
  MalformedRouteError,
  parseRouteRow,
} from "../../src/sheets/routes.js";

describe("parseRouteRow", () => {
  it("parses a fully-populated route row", () => {
    const route = parseRouteRow([
      "mid-ngn",
      "NGN",
      50000,
      500000,
      "transport,equipment",
      "U_PATRICK,U_STEPHAN",
    ]);
    expect(route).toEqual({
      route_id: "mid-ngn",
      currency: "NGN",
      min_amount: 50000,
      max_amount: 500000,
      category_filter: ["transport", "equipment"],
      approvers: ["U_PATRICK", "U_STEPHAN"],
    });
  });

  it("treats an empty max_amount cell as no upper bound (null)", () => {
    const route = parseRouteRow([
      "high-ngn",
      "NGN",
      500000,
      "",
      "",
      "U_PATRICK,U_TINUS,U_STEPHAN",
    ]);
    expect(route.max_amount).toBeNull();
  });

  it("treats an empty category_filter cell as 'all categories' (empty array)", () => {
    const route = parseRouteRow([
      "low-ngn",
      "NGN",
      0,
      50000,
      "",
      "U_STEPHAN",
    ]);
    expect(route.category_filter).toEqual([]);
  });

  it("trims whitespace inside CSV fields", () => {
    const route = parseRouteRow([
      "low-ngn",
      "NGN",
      0,
      50000,
      " transport , equipment ",
      "U_STEPHAN, U_PATRICK",
    ]);
    expect(route.category_filter).toEqual(["transport", "equipment"]);
    expect(route.approvers).toEqual(["U_STEPHAN", "U_PATRICK"]);
  });

  it("throws when min_amount is non-numeric", () => {
    expect(() =>
      parseRouteRow(["bad", "NGN", "abc", 100, "", "U_STEPHAN"]),
    ).toThrow(MalformedRouteError);
  });

  it("throws when max_amount is non-numeric (and not empty)", () => {
    expect(() =>
      parseRouteRow(["bad", "NGN", 0, "wat", "", "U_STEPHAN"]),
    ).toThrow(MalformedRouteError);
  });

  it("throws when min_amount is missing entirely", () => {
    expect(() =>
      parseRouteRow(["bad", "NGN", "", 100, "", "U_STEPHAN"]),
    ).toThrow(MalformedRouteError);
  });

  it("throws when there are no approvers", () => {
    expect(() => parseRouteRow(["bad", "NGN", 0, 100, "", ""])).toThrow(
      MalformedRouteError,
    );
  });

  it("throws when route_id is missing", () => {
    expect(() => parseRouteRow(["", "NGN", 0, 100, "", "U_X"])).toThrow(
      MalformedRouteError,
    );
  });

  it("throws when currency is missing", () => {
    expect(() => parseRouteRow(["x", "", 0, 100, "", "U_X"])).toThrow(
      MalformedRouteError,
    );
  });

  it("throws when max_amount is <= min_amount", () => {
    expect(() => parseRouteRow(["x", "NGN", 100, 100, "", "U_X"])).toThrow(
      MalformedRouteError,
    );
    expect(() => parseRouteRow(["x", "NGN", 100, 50, "", "U_X"])).toThrow(
      MalformedRouteError,
    );
  });
});
