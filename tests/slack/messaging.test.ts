import { describe, expect, it, vi } from "vitest";
import {
  ackInThread,
  dmUser,
  postEphemeral,
  updateMessage,
} from "../../src/slack/messaging.js";

interface MockClient {
  conversations: {
    open: ReturnType<typeof vi.fn>;
  };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    postEphemeral: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makeMockClient(): MockClient {
  return {
    conversations: { open: vi.fn() },
    chat: {
      postMessage: vi.fn(),
      postEphemeral: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe("dmUser", () => {
  it("opens a conversation, posts a message, and returns channel + ts", async () => {
    const client = makeMockClient();
    client.conversations.open.mockResolvedValue({
      channel: { id: "D123" },
    });
    client.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1715250000.000200",
    });

    const result = await dmUser(
      client as unknown as Parameters<typeof dmUser>[0],
      "UAPPROVER",
      [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
      "fallback",
    );

    expect(result).toEqual({ channel: "D123", ts: "1715250000.000200" });
    expect(client.conversations.open).toHaveBeenCalledWith({ users: "UAPPROVER" });
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        text: "fallback",
        blocks: expect.any(Array),
      }),
    );
  });

  it("throws if conversations.open returns no channel id", async () => {
    const client = makeMockClient();
    client.conversations.open.mockResolvedValue({});
    await expect(
      dmUser(
        client as unknown as Parameters<typeof dmUser>[0],
        "UAPPROVER",
        [],
        "f",
      ),
    ).rejects.toThrow();
  });

  it("throws if chat.postMessage returns no ts", async () => {
    const client = makeMockClient();
    client.conversations.open.mockResolvedValue({ channel: { id: "D123" } });
    client.chat.postMessage.mockResolvedValue({ ok: true });
    await expect(
      dmUser(
        client as unknown as Parameters<typeof dmUser>[0],
        "UAPPROVER",
        [],
        "f",
      ),
    ).rejects.toThrow();
  });
});

describe("ackInThread", () => {
  it("posts a thread reply with thread_ts set to the source message ts", async () => {
    const client = makeMockClient();
    client.chat.postMessage.mockResolvedValue({ ok: true });
    await ackInThread(
      client as unknown as Parameters<typeof ackInThread>[0],
      "C0EXPENSES",
      "1715250000.000100",
      "Logged",
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C0EXPENSES",
      thread_ts: "1715250000.000100",
      text: "Logged",
    });
  });
});

describe("updateMessage", () => {
  it("calls chat.update with channel, ts, blocks, and fallback text", async () => {
    const client = makeMockClient();
    client.chat.update.mockResolvedValue({ ok: true });
    await updateMessage(
      client as unknown as Parameters<typeof updateMessage>[0],
      "D123",
      "1715250000.000200",
      [{ type: "section" }],
      "fb",
    );
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "D123",
      ts: "1715250000.000200",
      text: "fb",
      blocks: [{ type: "section" }],
    });
  });
});

describe("postEphemeral", () => {
  it("calls chat.postEphemeral with channel + user + text", async () => {
    const client = makeMockClient();
    client.chat.postEphemeral.mockResolvedValue({ ok: true });
    await postEphemeral(
      client as unknown as Parameters<typeof postEphemeral>[0],
      "C0EXPENSES",
      "UREQ",
      "nudge",
    );
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C0EXPENSES",
      user: "UREQ",
      text: "nudge",
    });
  });
});
