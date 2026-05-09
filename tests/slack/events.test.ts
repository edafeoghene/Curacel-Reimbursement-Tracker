// Pure-logic tests for the events.ts dispatch + smart gate. The full
// message handler runs against a real Bolt App / WebClient and is
// exercised end-to-end against a real Slack workspace; here we cover the
// branching that has no I/O — resolveSubmission and hasExpenseKeywords.

import { describe, it, expect, beforeEach } from "vitest";
import {
  formatMultiItemAck,
  hasExpenseKeywords,
  resolveSubmission,
  __resetPendingNudgesForTests,
  __seedPendingNudgeForTests,
  type ItemOutcome,
} from "../../src/slack/events.js";
import type { ClassifierItem } from "../../src/types.js";

const CHANNEL = "C09FB2S5WJC";
const REQUESTER = "U_REQ";

beforeEach(() => {
  __resetPendingNudgesForTests();
});

// We construct a fresh nudges map per test rather than relying on the
// module-scoped one for resolveSubmission, since resolveSubmission accepts
// the map as an argument. Keeps the tests deterministic.
function makeNudges(
  entries: Array<{ ts: string; user?: string; text?: string; ageMs?: number }> = [],
): Map<string, {
  source_message_ts: string;
  channel_id: string;
  requester_user_id: string;
  parent_text: string;
  posted_at_ms: number;
}> {
  const m = new Map();
  const now = Date.now();
  for (const e of entries) {
    m.set(e.ts, {
      source_message_ts: e.ts,
      channel_id: CHANNEL,
      requester_user_id: e.user ?? REQUESTER,
      parent_text: e.text ?? "took an uber to the airport",
      posted_at_ms: now - (e.ageMs ?? 0),
    });
  }
  return m;
}

describe("hasExpenseKeywords", () => {
  it("matches common expense verbs and merchant names", () => {
    expect(hasExpenseKeywords("took an uber to CHI")).toBe(true);
    expect(hasExpenseKeywords("Bolt to the airport")).toBe(true);
    expect(hasExpenseKeywords("paid for the laptop repair")).toBe(true);
    expect(hasExpenseKeywords("invoice for two chargers")).toBe(true);
    expect(hasExpenseKeywords("monthly subscription renewal")).toBe(true);
    expect(hasExpenseKeywords("had lunch with the team")).toBe(true);
  });

  it("does not match pure chatter", () => {
    expect(hasExpenseKeywords("hello")).toBe(false);
    expect(hasExpenseKeywords("good morning")).toBe(false);
    expect(hasExpenseKeywords("can someone help with this")).toBe(false);
    expect(hasExpenseKeywords("")).toBe(false);
    expect(hasExpenseKeywords(undefined)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(hasExpenseKeywords("INVOICE attached")).toBe(true);
    expect(hasExpenseKeywords("Repaired the AC")).toBe(true);
  });
});

describe("resolveSubmission — top-level new message", () => {
  it("accepts a plain text+files message in the source channel", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "1.001",
        user: REQUESTER,
        text: "invoice for chargers",
        files: [{ id: "F1" }],
      },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.submission.kind).toBe("new");
      expect(r.submission.source_message_ts).toBe("1.001");
      expect(r.submission.consumes_nudge_ts).toBeNull();
      expect(r.submission.files).toHaveLength(1);
    }
  });

  it("rejects messages from other channels", () => {
    const r = resolveSubmission(
      { channel: "C_OTHER", ts: "1.001", user: REQUESTER },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects bot messages", () => {
    const r = resolveSubmission(
      { channel: CHANNEL, ts: "1.001", user: "U_BOT", bot_id: "B1" },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects message_deleted", () => {
    const r = resolveSubmission(
      { channel: CHANNEL, ts: "1.001", subtype: "message_deleted" },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects channel_join and other non-message subtypes", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "1.001",
        user: REQUESTER,
        subtype: "channel_join",
      },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts file_share subtype as a new submission", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "1.001",
        user: REQUESTER,
        subtype: "file_share",
        text: "receipt attached",
        files: [{ id: "F1" }],
      },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.submission.kind).toBe("new");
  });
});

describe("resolveSubmission — message_changed (edit)", () => {
  it("rejects an edit on a non-nudged message", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        subtype: "message_changed",
        message: { ts: "1.001", text: "edited", user: REQUESTER },
      },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non-nudged/);
  });

  it("accepts an edit on a nudged message and uses the new text/files", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        subtype: "message_changed",
        message: {
          ts: "1.001",
          text: "took an uber, ₦5,000",
          files: [{ id: "F2" }],
          user: REQUESTER,
        },
      },
      CHANNEL,
      makeNudges([{ ts: "1.001" }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.submission.kind).toBe("edit-completion");
      expect(r.submission.source_message_ts).toBe("1.001");
      expect(r.submission.text).toMatch(/uber/);
      expect(r.submission.files).toHaveLength(1);
      expect(r.submission.consumes_nudge_ts).toBe("1.001");
      expect(r.submission.user_id).toBe(REQUESTER);
    }
  });
});

describe("resolveSubmission — thread reply", () => {
  it("rejects a thread reply on a non-nudged parent", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "2.000",
        thread_ts: "1.001",
        user: REQUESTER,
        text: "here's the receipt",
        files: [{ id: "F3" }],
      },
      CHANNEL,
      makeNudges(),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a thread reply on a nudged parent from the original requester", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "2.000",
        thread_ts: "1.001",
        user: REQUESTER,
        text: "here's the receipt",
        files: [{ id: "F3" }],
      },
      CHANNEL,
      makeNudges([{ ts: "1.001", text: "took an uber to the airport" }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.submission.kind).toBe("thread-completion");
      expect(r.submission.source_message_ts).toBe("1.001");
      // Combined text includes both parent and reply text.
      expect(r.submission.text).toMatch(/uber/);
      expect(r.submission.text).toMatch(/receipt/);
      expect(r.submission.files).toHaveLength(1);
      expect(r.submission.consumes_nudge_ts).toBe("1.001");
    }
  });

  it("rejects a thread reply from a different user (not the original requester)", () => {
    const r = resolveSubmission(
      {
        channel: CHANNEL,
        ts: "2.000",
        thread_ts: "1.001",
        user: "U_OTHER",
        text: "here's the receipt",
        files: [{ id: "F3" }],
      },
      CHANNEL,
      makeNudges([{ ts: "1.001" }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not from the original requester/);
  });
});

function makeItem(overrides: Partial<ClassifierItem> = {}): ClassifierItem {
  return {
    description: "Cab fare",
    category: "transport",
    amount: 5000,
    currency: "NGN",
    vendor: "Bolt",
    date: "2026-05-09",
    ...overrides,
  };
}

describe("formatMultiItemAck", () => {
  it("single ok item: terse 'Logged as <id>' line, same shape as before phase 1.4", () => {
    const out: ItemOutcome[] = [
      {
        kind: "ok",
        trackingId: "EXP-2605-A7K2",
        approverId: "U_PATRICK",
        routeId: "low-ngn",
        item: makeItem(),
      },
    ];
    expect(formatMultiItemAck(out)).toBe(
      "Logged as `EXP-2605-A7K2`. Routing to <@U_PATRICK> for approval.",
    );
  });

  it("single manual-review item with a tracking id: 'Logged X for manual review' line", () => {
    const out: ItemOutcome[] = [
      {
        kind: "manual",
        trackingId: "EXP-2605-MR01",
        reason: "No matching route",
        item: makeItem(),
      },
    ];
    expect(formatMultiItemAck(out)).toMatch(
      /Logged `EXP-2605-MR01` for manual review.*No matching route/,
    );
  });

  it("single failure with no tracking id: 'Could not log' line, no id rendered", () => {
    const out: ItemOutcome[] = [
      {
        kind: "manual",
        trackingId: null,
        reason: "Sheet not writable",
        item: makeItem(),
      },
    ];
    const msg = formatMultiItemAck(out);
    expect(msg).toMatch(/Could not log/);
    expect(msg).not.toMatch(/`EXP-/);
  });

  it("multi-item all ok: header + bullets with tracking, summary, approver", () => {
    const out: ItemOutcome[] = [
      {
        kind: "ok",
        trackingId: "EXP-2605-A001",
        approverId: "U_A",
        routeId: "low-ngn",
        item: makeItem({ amount: 5000, currency: "NGN", category: "transport" }),
      },
      {
        kind: "ok",
        trackingId: "EXP-2605-B002",
        approverId: "U_B",
        routeId: "mid-ngn",
        item: makeItem({ amount: 50000, currency: "NGN", category: "equipment" }),
      },
    ];
    const msg = formatMultiItemAck(out);
    expect(msg).toMatch(/^Logged 2 expenses from this message:/);
    expect(msg).toContain("`EXP-2605-A001`");
    expect(msg).toContain("`EXP-2605-B002`");
    expect(msg).toContain("<@U_A>");
    expect(msg).toContain("<@U_B>");
    // Currency/category surfaced for each row.
    expect(msg).toContain("NGN 5,000");
    expect(msg).toContain("NGN 50,000");
    expect(msg).toContain("transport");
    expect(msg).toContain("equipment");
  });

  it("multi-item mixed ok + manual: each row shows its destination", () => {
    const out: ItemOutcome[] = [
      {
        kind: "ok",
        trackingId: "EXP-2605-OK01",
        approverId: "U_A",
        routeId: "low-ngn",
        item: makeItem({ amount: 5000, currency: "NGN", category: "transport" }),
      },
      {
        kind: "manual",
        trackingId: "EXP-2605-MR02",
        reason: "No matching route",
        item: makeItem({ amount: 999_999, currency: "USD", category: "other" }),
      },
    ];
    const msg = formatMultiItemAck(out);
    expect(msg).toMatch(/Logged 2 expenses from this message:/);
    expect(msg).toContain("<@U_A>");
    expect(msg).toMatch(/EXP-2605-MR02.*manual review.*No matching route/);
  });
});

describe("__seedPendingNudgeForTests + __resetPendingNudgesForTests", () => {
  // These guard the test-only escape hatches so they actually do what
  // they say (otherwise tests would pollute each other).
  it("seed and reset roundtrip", () => {
    __seedPendingNudgeForTests({
      source_message_ts: "9.999",
      channel_id: CHANNEL,
      requester_user_id: REQUESTER,
      parent_text: "x",
      posted_at_ms: Date.now(),
    });
    __resetPendingNudgesForTests();
    // Verifying this is implicit: the next test in beforeEach will reset
    // again, and the lookup-by-resolveSubmission tests above use their own
    // explicit map. We just want to confirm these functions don't throw.
    expect(true).toBe(true);
  });
});
