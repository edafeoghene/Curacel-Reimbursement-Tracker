// postFeedLine: best-effort one-liner publisher for the optional
// #expense-log feed channel. The helper must:
//   - no-op when EXPENSE_LOG_CHANNEL_ID is empty (legitimate default)
//   - swallow errors so a misconfigured channel can't break the flow

import { describe, expect, it, vi } from "vitest";
import { postFeedLine } from "../../src/slack/feed.js";
import type { Config } from "../../src/config.js";

function makeConfig(channel: string | undefined): Config {
  // Only the field used by postFeedLine matters; the rest are stubs.
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_SIGNING_SECRET: "test",
    EXPENSES_CHANNEL_ID: "C_TEST",
    FINANCIAL_MANAGER_USER_ID: "U_FM",
    OPENROUTER_API_KEY: "or-test",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "eyJ9",
    GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-test",
    EXPENSE_LOG_CHANNEL_ID: channel,
    PORT: 3000,
    LOG_LEVEL: "info",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Config;
}

describe("postFeedLine", () => {
  it("no-ops silently when EXPENSE_LOG_CHANNEL_ID is undefined", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const client = { chat: { postMessage } };
    await postFeedLine(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      makeConfig(undefined),
      "anything",
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts the line to the configured channel when set", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const client = { chat: { postMessage } };
    await postFeedLine(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      makeConfig("C_FEED"),
      "Approved: `EXP-2605-A7K2` by <@U>",
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_FEED",
      text: "Approved: `EXP-2605-A7K2` by <@U>",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("swallows postMessage errors so the caller's flow isn't affected", async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValue(new Error("channel_not_found"));
    const client = { chat: { postMessage } };
    // No throw expected.
    await expect(
      postFeedLine(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        makeConfig("C_GONE"),
        "Cancelled: `EXP-2605-A7K2`",
      ),
    ).resolves.toBeUndefined();
  });
});
