import { describe, expect, it } from "vitest";

import { decideSignIn, parseAllowlist } from "./allowlist";

describe("parseAllowlist", () => {
  it("returns an empty set for undefined / empty / whitespace-only inputs", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist("").size).toBe(0);
    expect(parseAllowlist("   ").size).toBe(0);
    expect(parseAllowlist(",,,").size).toBe(0);
  });

  it("lowercases and trims each entry", () => {
    const set = parseAllowlist(" Alice@Curacel.ai , BOB@curacel.AI ");
    expect(set).toEqual(new Set(["alice@curacel.ai", "bob@curacel.ai"]));
  });

  it("drops empty entries from spurious commas", () => {
    const set = parseAllowlist(",alice@curacel.ai,,bob@curacel.ai,");
    expect(set).toEqual(new Set(["alice@curacel.ai", "bob@curacel.ai"]));
  });

  it("deduplicates equal entries (Set semantics)", () => {
    const set = parseAllowlist("alice@curacel.ai,Alice@curacel.ai");
    expect(set.size).toBe(1);
  });
});

describe("decideSignIn", () => {
  const allowlist = parseAllowlist("alice@curacel.ai,bob@curacel.ai");

  it("allows a curacel email that's on the list with the right hd", () => {
    expect(
      decideSignIn({ email: "alice@curacel.ai", hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: true });
  });

  it("normalizes the email before checking the list (case + whitespace)", () => {
    expect(
      decideSignIn({ email: " ALICE@curacel.ai ", hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: true });
  });

  it("rejects an empty email outright", () => {
    expect(
      decideSignIn({ email: "", hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: false, reason: "no-email" });
    expect(
      decideSignIn({ email: null, hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: false, reason: "no-email" });
    expect(
      decideSignIn({ email: undefined, hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: false, reason: "no-email" });
  });

  it("rejects a non-curacel email even with the right hd", () => {
    expect(
      decideSignIn({ email: "alice@gmail.com", hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: false, reason: "wrong-domain" });
  });

  it("rejects a curacel email when hd is missing or wrong", () => {
    expect(
      decideSignIn({ email: "alice@curacel.ai", hd: null, allowlist }),
    ).toEqual({ allowed: false, reason: "wrong-hd" });
    expect(
      decideSignIn({ email: "alice@curacel.ai", hd: "personal.com", allowlist }),
    ).toEqual({ allowed: false, reason: "wrong-hd" });
  });

  it("rejects a curacel email that's not on the allowlist", () => {
    expect(
      decideSignIn({ email: "carol@curacel.ai", hd: "curacel.ai", allowlist }),
    ).toEqual({ allowed: false, reason: "not-on-allowlist" });
  });

  it("rejects everyone when the allowlist is empty (fail-closed default)", () => {
    expect(
      decideSignIn({ email: "alice@curacel.ai", hd: "curacel.ai", allowlist: new Set() }),
    ).toEqual({ allowed: false, reason: "not-on-allowlist" });
  });

  it("doesn't accept a domain that just contains 'curacel.ai' as a substring", () => {
    expect(
      decideSignIn({
        email: "alice@evil-curacel.ai",
        hd: "curacel.ai",
        allowlist,
      }),
    ).toEqual({ allowed: false, reason: "wrong-domain" });
  });
});
