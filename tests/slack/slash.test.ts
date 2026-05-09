// /expense-resume + /expense-cancel slash-command argument parser. Both
// commands take the same EXP-YYMM-XXXX shape, so they share parseTrackingIdArg.

import { describe, expect, it } from "vitest";
import { parseResumeArg, parseTrackingIdArg } from "../../src/slack/slash.js";

describe("parseTrackingIdArg", () => {
  it("accepts a plain canonical tracking id", () => {
    expect(parseTrackingIdArg("EXP-2605-A7K2")).toBe("EXP-2605-A7K2");
  });

  it("trims surrounding whitespace", () => {
    expect(parseTrackingIdArg("  EXP-2605-A7K2  ")).toBe("EXP-2605-A7K2");
  });

  it("strips wrapping backticks (Slack auto-formats `code` snippets)", () => {
    expect(parseTrackingIdArg("`EXP-2605-A7K2`")).toBe("EXP-2605-A7K2");
  });

  it("takes only the first whitespace-delimited token", () => {
    expect(parseTrackingIdArg("EXP-2605-A7K2 please")).toBe("EXP-2605-A7K2");
  });

  it("returns null for empty input", () => {
    expect(parseTrackingIdArg("")).toBeNull();
    expect(parseTrackingIdArg("   ")).toBeNull();
  });

  it("returns null for a malformed tracking id", () => {
    expect(parseTrackingIdArg("EXP-2605-AAA")).toBeNull(); // 3 chars after dash
    expect(parseTrackingIdArg("EXP-26-A7K2")).toBeNull(); // 2 char date segment
    expect(parseTrackingIdArg("EXP-2605-aaaa")).toBeNull(); // lowercase
    expect(parseTrackingIdArg("not a tracking id")).toBeNull();
  });

  it("rejects ids using ambiguous alphabet characters", () => {
    // The canonical alphabet excludes O, I, 1, 0 to stay copy-paste safe.
    expect(parseTrackingIdArg("EXP-2605-AOK2")).toBeNull();
    expect(parseTrackingIdArg("EXP-2605-A1K2")).toBeNull();
  });
});

describe("parseResumeArg (Phase 1.2 alias kept for clarity)", () => {
  it("aliases parseTrackingIdArg one-to-one", () => {
    expect(parseResumeArg).toBe(parseTrackingIdArg);
  });
});
