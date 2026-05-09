// /expense-resume slash-command argument parser. The parser is broken out
// from the handler so the edge cases (whitespace, backticks, malformed ids,
// trailing junk) can be exercised without a Slack mock.

import { describe, expect, it } from "vitest";
import { parseResumeArg } from "../../src/slack/slash.js";

describe("parseResumeArg", () => {
  it("accepts a plain canonical tracking id", () => {
    expect(parseResumeArg("EXP-2605-A7K2")).toBe("EXP-2605-A7K2");
  });

  it("trims surrounding whitespace", () => {
    expect(parseResumeArg("  EXP-2605-A7K2  ")).toBe("EXP-2605-A7K2");
  });

  it("strips wrapping backticks (Slack auto-formats `code` snippets)", () => {
    expect(parseResumeArg("`EXP-2605-A7K2`")).toBe("EXP-2605-A7K2");
  });

  it("takes only the first whitespace-delimited token", () => {
    expect(parseResumeArg("EXP-2605-A7K2 please")).toBe("EXP-2605-A7K2");
  });

  it("returns null for empty input", () => {
    expect(parseResumeArg("")).toBeNull();
    expect(parseResumeArg("   ")).toBeNull();
  });

  it("returns null for a malformed tracking id", () => {
    expect(parseResumeArg("EXP-2605-AAA")).toBeNull(); // 3 chars after dash
    expect(parseResumeArg("EXP-26-A7K2")).toBeNull(); // 2 char date segment
    expect(parseResumeArg("EXP-2605-aaaa")).toBeNull(); // lowercase
    expect(parseResumeArg("not a tracking id")).toBeNull();
  });

  it("rejects ids using ambiguous alphabet characters", () => {
    // The canonical alphabet excludes O, I, 1, 0 to stay copy-paste safe.
    expect(parseResumeArg("EXP-2605-AOK2")).toBeNull();
    expect(parseResumeArg("EXP-2605-A1K2")).toBeNull();
  });
});
