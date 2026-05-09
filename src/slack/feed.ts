// Optional read-only feed channel. PLAN.md §19 Phase 1.7.
//
// Posts a one-liner per state transition to `EXPENSE_LOG_CHANNEL_ID` if
// the env var is set. The feed is best-effort: errors are logged but
// never propagated, so a misconfigured channel can't break the main flow.
//
// Callers compose the line text themselves (e.g. "Approved: ` + tracking
// + ` by <@U>") so the audit-readable nuance is preserved without the
// helper having to know which transition it is.

import type { WebClient } from "@slack/web-api";

import type { Config } from "../config.js";

/**
 * Post a one-line feed entry. No-op when `EXPENSE_LOG_CHANNEL_ID` is empty.
 * Errors are swallowed with a warning — the feed is decoration, not
 * load-bearing, so a 404 on a renamed channel mustn't break approvals.
 */
export async function postFeedLine(
  client: WebClient,
  config: Config,
  text: string,
): Promise<void> {
  const channel = config.EXPENSE_LOG_CHANNEL_ID;
  if (!channel) return;
  try {
    await client.chat.postMessage({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[feed] postFeedLine failed:", err);
  }
}
