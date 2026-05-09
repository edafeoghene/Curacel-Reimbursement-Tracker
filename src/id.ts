// Tracking ID generator and validator.
// Format (PLAN.md §12): EXP-YYMM-XXXX
//   - "EXP" fixed prefix
//   - YYMM: 2-digit year + 2-digit month
//   - XXXX: 4 chars from a Crockford-ish alphabet (no 0/O/1/I/L)
//
// Random source is `crypto.randomBytes` (Node built-in). Math.random is not
// cryptographically uniform and not suitable here.

import { randomBytes } from "node:crypto";

// 32-character alphabet with ambiguous chars (0, O, 1, I, L) removed.
// 32 = 2^5, so each char encodes 5 bits cleanly with no modulo bias when we
// mask 8 random bits down to the low 5 bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const TRACKING_ID_REGEX = new RegExp(
  `^EXP-\\d{4}-[${ALPHABET}]{4}$`,
);

/**
 * Generate a fresh tracking ID. `now` defaults to the current time and is
 * exposed as an argument to make tests deterministic.
 */
export function generateTrackingId(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");

  // 4 random characters from ALPHABET. We pull 4 bytes and mask each to its
  // low 5 bits — since the alphabet is exactly 32 chars, this is unbiased.
  const bytes = randomBytes(4);
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    // Bytes are 0-255; mask to 0-31 by taking low 5 bits.
    // Non-null assertion is safe: i < bytes.length (=4) by construction.
    const idx = bytes[i]! & 0x1f;
    suffix += ALPHABET[idx];
  }

  return `EXP-${yy}${mm}-${suffix}`;
}

/**
 * Strict validator. True only for IDs matching the canonical format above —
 * 4 digits in YYMM, 4 chars from the unambiguous alphabet, exact dashes.
 */
export function isValidTrackingId(s: string): boolean {
  return TRACKING_ID_REGEX.test(s);
}
