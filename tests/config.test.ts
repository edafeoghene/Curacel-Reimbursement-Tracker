import { describe, expect, it } from "vitest";
import { loadConfigOrThrow } from "../src/config.js";

// Build a base env that satisfies every required var. Individual tests then
// mutate exactly one field to assert it's the cause of the failure.
function makeValidEnv(): NodeJS.ProcessEnv {
  // Minimum-viable service account JSON: only client_email + private_key
  // are checked by config (the full key isn't validated cryptographically).
  const sa = {
    client_email: "bot@example.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
  };
  const saB64 = Buffer.from(JSON.stringify(sa), "utf8").toString("base64");

  return {
    SLACK_BOT_TOKEN: "xoxb-1234567890",
    SLACK_APP_TOKEN: "xapp-abcdef",
    OPENROUTER_API_KEY: "sk-or-v1-something",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    GOOGLE_SHEETS_ID: "1AbCdEfGh",
    GOOGLE_SERVICE_ACCOUNT_B64: saB64,
    EXPENSES_CHANNEL_ID: "C01234567",
    EXPENSE_LOG_CHANNEL_ID: "C09876543",
    FINANCIAL_MANAGER_USER_ID: "U0FINMGR",
    PORT: "4000",
    NODE_ENV: "test",
    LOG_LEVEL: "info",
  };
}

describe("config: happy path", () => {
  it("parses a fully valid env", () => {
    const cfg = loadConfigOrThrow(makeValidEnv());
    expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-1234567890");
    expect(cfg.OPENROUTER_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(cfg.PORT).toBe(4000);
    expect(cfg.EXPENSE_LOG_CHANNEL_ID).toBe("C09876543");
  });

  it("accepts a W-prefixed enterprise user id for FINANCIAL_MANAGER_USER_ID", () => {
    const env = makeValidEnv();
    env.FINANCIAL_MANAGER_USER_ID = "WGRIDUSER";
    const cfg = loadConfigOrThrow(env);
    expect(cfg.FINANCIAL_MANAGER_USER_ID).toBe("WGRIDUSER");
  });

  it("treats EXPENSE_LOG_CHANNEL_ID as optional", () => {
    const env = makeValidEnv();
    delete env.EXPENSE_LOG_CHANNEL_ID;
    const cfg = loadConfigOrThrow(env);
    expect(cfg.EXPENSE_LOG_CHANNEL_ID).toBeUndefined();
  });

  it("defaults PORT to 3000 when unset", () => {
    const env = makeValidEnv();
    delete env.PORT;
    const cfg = loadConfigOrThrow(env);
    expect(cfg.PORT).toBe(3000);
  });
});

describe("config: missing required vars", () => {
  it.each([
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "GOOGLE_SHEETS_ID",
    "GOOGLE_SERVICE_ACCOUNT_B64",
    "EXPENSES_CHANNEL_ID",
    "FINANCIAL_MANAGER_USER_ID",
  ])("fails when %s is missing", (key) => {
    const env = makeValidEnv();
    delete env[key as keyof NodeJS.ProcessEnv];
    expect(() => loadConfigOrThrow(env)).toThrow(/Config validation failed/);
  });
});

describe("config: token-shape sanity", () => {
  it("rejects a SLACK_BOT_TOKEN that does not start with xoxb-", () => {
    const env = makeValidEnv();
    env.SLACK_BOT_TOKEN = "wrong-prefix";
    expect(() => loadConfigOrThrow(env)).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("rejects a SLACK_APP_TOKEN that does not start with xapp-", () => {
    const env = makeValidEnv();
    env.SLACK_APP_TOKEN = "xoxa-other";
    expect(() => loadConfigOrThrow(env)).toThrow(/SLACK_APP_TOKEN/);
  });

  it("rejects an OPENROUTER_API_KEY that does not start with sk-or-", () => {
    const env = makeValidEnv();
    env.OPENROUTER_API_KEY = "sk-anthropic-bad";
    expect(() => loadConfigOrThrow(env)).toThrow(/OPENROUTER_API_KEY/);
  });

  it("rejects an EXPENSES_CHANNEL_ID that does not start with C", () => {
    const env = makeValidEnv();
    env.EXPENSES_CHANNEL_ID = "X12345";
    expect(() => loadConfigOrThrow(env)).toThrow(/EXPENSES_CHANNEL_ID/);
  });

  it("rejects an EXPENSE_LOG_CHANNEL_ID that does not start with C (when set)", () => {
    const env = makeValidEnv();
    env.EXPENSE_LOG_CHANNEL_ID = "G_PRIVATE";
    expect(() => loadConfigOrThrow(env)).toThrow(/EXPENSE_LOG_CHANNEL_ID/);
  });

  it("rejects a FINANCIAL_MANAGER_USER_ID that does not start with U or W", () => {
    const env = makeValidEnv();
    env.FINANCIAL_MANAGER_USER_ID = "X12345";
    expect(() => loadConfigOrThrow(env)).toThrow(/FINANCIAL_MANAGER_USER_ID/);
  });
});

describe("config: GOOGLE_SERVICE_ACCOUNT_B64 validation", () => {
  it("rejects non-base64 garbage that doesn't decode to JSON", () => {
    const env = makeValidEnv();
    // Base64 of a non-JSON string.
    env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from("not json at all", "utf8").toString("base64");
    expect(() => loadConfigOrThrow(env)).toThrow(/GOOGLE_SERVICE_ACCOUNT_B64/);
  });

  it("rejects JSON missing client_email", () => {
    const env = makeValidEnv();
    env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from(
      JSON.stringify({ private_key: "x" }),
      "utf8",
    ).toString("base64");
    expect(() => loadConfigOrThrow(env)).toThrow(/client_email/);
  });

  it("rejects JSON missing private_key", () => {
    const env = makeValidEnv();
    env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from(
      JSON.stringify({ client_email: "x@y" }),
      "utf8",
    ).toString("base64");
    expect(() => loadConfigOrThrow(env)).toThrow(/private_key/);
  });
});
