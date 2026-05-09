import { describe, expect, it } from "vitest";
import { generateTrackingId, isValidTrackingId } from "../src/id.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// The spec alphabet excludes 0/1/I/O. It deliberately keeps L (PLAN.md §12).
// `L` is borderline-ambiguous with `1` in some fonts but the spec preserves
// it to keep the alphabet at exactly 32 characters (a power of two), which
// lets the generator mask 5 random bits with zero modulo bias.
const AMBIGUOUS = ["0", "O", "1", "I"];

describe("generateTrackingId: format", () => {
  it("produces a string in the EXP-YYMM-XXXX shape", () => {
    const id = generateTrackingId(new Date(Date.UTC(2026, 4, 9)));
    expect(id).toMatch(/^EXP-\d{4}-[A-Z0-9]{4}$/);
  });

  it("uses YYMM derived from the supplied date (UTC)", () => {
    // May 2026 → YY=26, MM=05
    const id = generateTrackingId(new Date(Date.UTC(2026, 4, 9)));
    expect(id.startsWith("EXP-2605-")).toBe(true);
  });

  it("zero-pads single-digit months", () => {
    // January 2026 → MM=01
    const id = generateTrackingId(new Date(Date.UTC(2026, 0, 1)));
    expect(id.startsWith("EXP-2601-")).toBe(true);
  });

  it("handles December 2099 boundary", () => {
    const id = generateTrackingId(new Date(Date.UTC(2099, 11, 31)));
    expect(id.startsWith("EXP-9912-")).toBe(true);
  });

  it("handles year 2000 → YY=00", () => {
    const id = generateTrackingId(new Date(Date.UTC(2000, 0, 1)));
    expect(id.startsWith("EXP-0001-")).toBe(true);
  });
});

describe("generateTrackingId: random suffix character set", () => {
  it("never emits ambiguous characters across many iterations", () => {
    const fixedDate = new Date(Date.UTC(2026, 4, 9));
    for (let i = 0; i < 500; i++) {
      const id = generateTrackingId(fixedDate);
      const suffix = id.slice(-4);
      for (const ch of suffix) {
        expect(AMBIGUOUS).not.toContain(ch);
        expect(ALPHABET).toContain(ch);
      }
    }
  });

  it("eventually exercises a wide spread of the alphabet", () => {
    // Sanity check: with 500 iterations × 4 chars = 2000 chars from a 32-char
    // alphabet, we should easily see at least 20 distinct characters.
    const fixedDate = new Date(Date.UTC(2026, 4, 9));
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = generateTrackingId(fixedDate);
      for (const ch of id.slice(-4)) seen.add(ch);
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it("uses crypto-grade randomness — IDs are not all identical", () => {
    const fixedDate = new Date(Date.UTC(2026, 4, 9));
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) {
      set.add(generateTrackingId(fixedDate));
    }
    // 100 attempts on a 32^4 = ~1M space → expect ~100 unique results.
    expect(set.size).toBeGreaterThan(90);
  });
});

describe("generateTrackingId: default `now` argument", () => {
  it("works with no argument (uses current date)", () => {
    const id = generateTrackingId();
    expect(isValidTrackingId(id)).toBe(true);
  });
});

describe("isValidTrackingId", () => {
  it("accepts canonical IDs", () => {
    expect(isValidTrackingId("EXP-2605-A7K2")).toBe(true);
    expect(isValidTrackingId("EXP-0001-ABCD")).toBe(true);
    expect(isValidTrackingId("EXP-9912-2345")).toBe(true);
  });

  it("rejects IDs with a missing prefix", () => {
    expect(isValidTrackingId("2605-A7K2")).toBe(false);
    expect(isValidTrackingId("EXP2605A7K2")).toBe(false);
  });

  it("rejects wrong segment lengths", () => {
    expect(isValidTrackingId("EXP-260-A7K2")).toBe(false);
    expect(isValidTrackingId("EXP-26050-A7K2")).toBe(false);
    expect(isValidTrackingId("EXP-2605-A7K")).toBe(false);
    expect(isValidTrackingId("EXP-2605-A7K23")).toBe(false);
  });

  it("rejects non-digit YYMM", () => {
    expect(isValidTrackingId("EXP-26AB-A7K2")).toBe(false);
    expect(isValidTrackingId("EXP-XXXX-A7K2")).toBe(false);
  });

  it("rejects chars not in the spec alphabet (0, 1, I, O)", () => {
    expect(isValidTrackingId("EXP-2605-A0K2")).toBe(false); // 0
    expect(isValidTrackingId("EXP-2605-AOK2")).toBe(false); // O
    expect(isValidTrackingId("EXP-2605-A1K2")).toBe(false); // 1
    expect(isValidTrackingId("EXP-2605-AIK2")).toBe(false); // I
  });

  it("rejects lowercase suffix", () => {
    expect(isValidTrackingId("EXP-2605-a7k2")).toBe(false);
  });

  it("rejects empty / garbage strings", () => {
    expect(isValidTrackingId("")).toBe(false);
    expect(isValidTrackingId("not-an-id")).toBe(false);
    expect(isValidTrackingId("   ")).toBe(false);
  });

  it("agrees with generator output across many iterations", () => {
    const fixedDate = new Date(Date.UTC(2026, 4, 9));
    for (let i = 0; i < 200; i++) {
      expect(isValidTrackingId(generateTrackingId(fixedDate))).toBe(true);
    }
  });
});
