// Slack users.info wrapper with a per-process display-name cache.
//
// Why a cache: the bot calls users.info per Slack user id when it needs a
// human-readable name (audit log, approval row, FM DM tag). Names rarely
// change and the API has tight rate limits. Cache lives for the process
// lifetime; if a user renames themselves we'll show the stale name until
// next restart, which is acceptable for an internal tool.

import type { WebClient } from "@slack/web-api";

const userNameCache = new Map<string, string>();

/**
 * Resolve a Slack user id to a display-name string. Falls back to the
 * raw user id on any API failure. Never throws.
 */
export async function fetchUserName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const name =
      res.user?.profile?.display_name ||
      res.user?.profile?.real_name ||
      res.user?.real_name ||
      res.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Test-only: clear the in-memory cache between cases. */
export function __resetUserNameCacheForTests(): void {
  userNameCache.clear();
}
