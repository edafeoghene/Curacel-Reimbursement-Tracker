// FM allowlist gate. Centralized so the signIn callback and any future
// re-checks (e.g. sheet-read filtering) share the same parser semantics.

const CURACEL_DOMAIN = "curacel.ai";

/**
 * Parse the comma-separated `ALLOWED_FM_EMAILS` env var into a normalized
 * Set. Lowercased + trimmed; empty / whitespace-only entries dropped.
 *
 * An empty / unset env var deliberately yields an EMPTY set — i.e. nobody
 * is allowed. That is the correct fail-closed default for a deploy that
 * forgot to set the var; we never want a misconfig to let the world in.
 */
export function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Decide whether a given Google identity is allowed to sign in.
 *
 * Checks (all must pass):
 *   1. email is non-empty AND lowercases to something on the allowlist
 *   2. email ends in `@curacel.ai` (defense-in-depth — allowlist is
 *      the load-bearing gate, but the domain check makes a misconfigured
 *      allowlist that accidentally contains a non-Curacel address still
 *      fail closed)
 *   3. Google's `hd` claim equals `curacel.ai` (Google's hosted-domain
 *      claim — only set for Workspace accounts on the right tenant; not
 *      forgeable by a personal gmail user since it comes from Google's
 *      ID token, which we trust because Auth.js verified the signature)
 *
 * `hd` is the strongest signal but optional in the type, so we treat
 * missing `hd` as a hard fail.
 */
export interface AllowlistDecision {
  allowed: boolean;
  /**
   * Reason for refusal, for observability / the redirect query string.
   * Never shown verbatim to end users (no enumeration: "you're not on the
   * list" is the same UI as "your domain is wrong").
   */
  reason?: "no-email" | "wrong-domain" | "wrong-hd" | "not-on-allowlist";
}

export function decideSignIn(input: {
  email: string | null | undefined;
  hd: string | null | undefined;
  allowlist: Set<string>;
}): AllowlistDecision {
  const { email, hd, allowlist } = input;

  if (!email) return { allowed: false, reason: "no-email" };

  const normalized = email.trim().toLowerCase();

  if (!normalized.endsWith(`@${CURACEL_DOMAIN}`)) {
    return { allowed: false, reason: "wrong-domain" };
  }

  if (hd !== CURACEL_DOMAIN) {
    return { allowed: false, reason: "wrong-hd" };
  }

  if (!allowlist.has(normalized)) {
    return { allowed: false, reason: "not-on-allowlist" };
  }

  return { allowed: true };
}
