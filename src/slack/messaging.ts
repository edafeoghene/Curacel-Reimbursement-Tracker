// Slack messaging helpers — DM, thread, ephemeral, update.
//
// Every helper takes a `WebClient` argument so they're trivially mockable.
// They return only the data the caller needs (e.g. `{ channel, ts }` from a
// DM post so the approval row can store the coords for later `chat.update`).

import type { WebClient } from "@slack/web-api";

export type Block = Record<string, unknown>;

/**
 * Reply in a thread on the source message. Used for the "Logged as ${id}.
 * Routing to <@approver>." ack and for status posts back to the requester.
 */
export async function ackInThread(
  client: WebClient,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

/**
 * Open a DM with `userId` and post a blocks message. Returns the IM channel
 * ID and message ts so the caller can store them on the approval row for a
 * later `chat.update`.
 */
export async function dmUser(
  client: WebClient,
  userId: string,
  blocks: Block[],
  fallbackText: string,
): Promise<{ channel: string; ts: string }> {
  const open = await client.conversations.open({ users: userId });
  const channel = open.channel?.id;
  if (!channel) {
    throw new Error(`conversations.open returned no channel id for user ${userId}`);
  }
  const posted = await client.chat.postMessage({
    channel,
    text: fallbackText,
    // Block-kit shapes are validated at runtime by Slack; the Bolt typing is
    // strict about discriminated unions which our generic `Block` deliberately
    // is not. Pass through.
    blocks: blocks as unknown as never,
  });
  if (!posted.ts) {
    throw new Error(`chat.postMessage returned no ts for DM to ${userId}`);
  }
  return { channel, ts: posted.ts };
}

/**
 * Edit an existing message. Used after every button click to remove the
 * button (prevents stale clicks per PLAN.md §18).
 */
export async function updateMessage(
  client: WebClient,
  channelId: string,
  ts: string,
  blocks: Block[],
  fallbackText: string,
): Promise<void> {
  await client.chat.update({
    channel: channelId,
    ts,
    text: fallbackText,
    blocks: blocks as unknown as never,
  });
}

/**
 * Post an ephemeral message to a single user in a channel. Used for the
 * pre-classification nudge and for authorization rejections.
 */
export async function postEphemeral(
  client: WebClient,
  channelId: string,
  userId: string,
  text: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
  });
}
