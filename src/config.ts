// Env-var validation. Fail fast at boot.
//
// Per PLAN.md §16 + §18: every required variable must be present and shaped
// correctly. Token prefixes are sanity-checked (`xoxb-`, `xapp-`, `sk-or-`,
// channel `C…`, user `U…|W…`). The Google service-account blob is base64
// decoded and parsed for `client_email` + `private_key`.
//
// dotenv/config is loaded at the top of src/index.ts — NOT here. This module
// purely validates `process.env` and exposes a frozen `config` object.

import { z } from "zod";

const tokenPrefix = (prefix: string, label: string) =>
  z.string().refine((v) => v.startsWith(prefix), {
    message: `${label} must start with "${prefix}"`,
  });

const slackChannelId = z
  .string()
  .refine((v) => v.startsWith("C"), {
    message: "Slack channel IDs must start with 'C'",
  });

const slackUserId = z.string().refine((v) => /^[UW]/.test(v), {
  message: "Slack user IDs must start with 'U' or 'W'",
});

// PORT may be missing (default 3000) or a string of digits.
const portSchema = z
  .union([
    z.undefined(),
    z
      .string()
      .refine((v) => /^\d+$/.test(v), {
        message: "must be a positive integer",
      })
      .transform((v) => Number(v)),
  ])
  .transform((v) => (typeof v === "number" ? v : 3000));

// GOOGLE_SERVICE_ACCOUNT_B64 — base64 → JSON → has client_email + private_key.
const googleServiceAccountB64 = z
  .string()
  .min(1, "GOOGLE_SERVICE_ACCOUNT_B64 is required")
  .superRefine((raw, ctx) => {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not valid base64: ${(err as Error).message}`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `did not decode to valid JSON: ${(err as Error).message}`,
      });
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).client_email !== "string" ||
      typeof (parsed as Record<string, unknown>).private_key !== "string"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "decoded JSON is missing required fields (client_email, private_key)",
      });
    }
  });

const Schema = z.object({
  // Slack
  SLACK_BOT_TOKEN: tokenPrefix("xoxb-", "SLACK_BOT_TOKEN"),
  SLACK_APP_TOKEN: tokenPrefix("xapp-", "SLACK_APP_TOKEN"),

  // LLM gateway. The env var name keeps its OpenRouter origin, but the key
  // is whatever the active gateway expects (OpenRouter `sk-or-…`, Google
  // Gemini `AIza…`, etc.) — see OPENROUTER_BASE_URL in src/llm/client.ts.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().min(1, "OPENROUTER_MODEL is required"),

  // Google Sheets
  GOOGLE_SHEETS_ID: z.string().min(1, "GOOGLE_SHEETS_ID is required"),
  GOOGLE_SERVICE_ACCOUNT_B64: googleServiceAccountB64,

  // Slack channel/user IDs
  EXPENSES_CHANNEL_ID: slackChannelId,
  // Empty string in .env counts as "unset" for this optional channel.
  EXPENSE_LOG_CHANNEL_ID: z
    .preprocess((v) => (v === "" ? undefined : v), slackChannelId.optional()),
  FINANCIAL_MANAGER_USER_ID: slackUserId,

  // Runtime
  PORT: portSchema,
  NODE_ENV: z.string().optional().default("development"),
  LOG_LEVEL: z.string().optional().default("info"),
});

export type Config = Readonly<{
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_SERVICE_ACCOUNT_B64: string;
  EXPENSES_CHANNEL_ID: string;
  EXPENSE_LOG_CHANNEL_ID: string | undefined;
  FINANCIAL_MANAGER_USER_ID: string;
  PORT: number;
  NODE_ENV: string;
  LOG_LEVEL: string;
}>;

/**
 * Validate `process.env` against the schema. On failure, log every issue and
 * exit the process with code 1. On success, return a frozen config object.
 *
 * Exposed for tests; production callers should import the `config` singleton.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse({
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    GOOGLE_SHEETS_ID: env.GOOGLE_SHEETS_ID,
    GOOGLE_SERVICE_ACCOUNT_B64: env.GOOGLE_SERVICE_ACCOUNT_B64,
    EXPENSES_CHANNEL_ID: env.EXPENSES_CHANNEL_ID,
    EXPENSE_LOG_CHANNEL_ID: env.EXPENSE_LOG_CHANNEL_ID,
    FINANCIAL_MANAGER_USER_ID: env.FINANCIAL_MANAGER_USER_ID,
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("[config] environment validation failed:");
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      // eslint-disable-next-line no-console
      console.error(`  - ${path}: ${issue.message}`);
    }
    process.exit(1);
  }

  const data = parsed.data;
  const port =
    typeof data.PORT === "number" ? data.PORT : Number(data.PORT ?? 3000);

  const cfg: Config = Object.freeze({
    SLACK_BOT_TOKEN: data.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: data.SLACK_APP_TOKEN,
    OPENROUTER_API_KEY: data.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: data.OPENROUTER_MODEL,
    GOOGLE_SHEETS_ID: data.GOOGLE_SHEETS_ID,
    GOOGLE_SERVICE_ACCOUNT_B64: data.GOOGLE_SERVICE_ACCOUNT_B64,
    EXPENSES_CHANNEL_ID: data.EXPENSES_CHANNEL_ID,
    EXPENSE_LOG_CHANNEL_ID: data.EXPENSE_LOG_CHANNEL_ID,
    FINANCIAL_MANAGER_USER_ID: data.FINANCIAL_MANAGER_USER_ID,
    PORT: Number.isFinite(port) ? port : 3000,
    NODE_ENV: data.NODE_ENV,
    LOG_LEVEL: data.LOG_LEVEL,
  });
  return cfg;
}

/**
 * Test-only variant: validate and either return the config or throw with all
 * the issue messages joined — never calls process.exit. Used by config.test.ts.
 */
export function loadConfigOrThrow(env: NodeJS.ProcessEnv): Config {
  const parsed = Schema.safeParse({
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    GOOGLE_SHEETS_ID: env.GOOGLE_SHEETS_ID,
    GOOGLE_SERVICE_ACCOUNT_B64: env.GOOGLE_SERVICE_ACCOUNT_B64,
    EXPENSES_CHANNEL_ID: env.EXPENSES_CHANNEL_ID,
    EXPENSE_LOG_CHANNEL_ID: env.EXPENSE_LOG_CHANNEL_ID,
    FINANCIAL_MANAGER_USER_ID: env.FINANCIAL_MANAGER_USER_ID,
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Config validation failed: ${msg}`);
  }
  const data = parsed.data;
  const port =
    typeof data.PORT === "number" ? data.PORT : Number(data.PORT ?? 3000);
  return Object.freeze({
    SLACK_BOT_TOKEN: data.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: data.SLACK_APP_TOKEN,
    OPENROUTER_API_KEY: data.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: data.OPENROUTER_MODEL,
    GOOGLE_SHEETS_ID: data.GOOGLE_SHEETS_ID,
    GOOGLE_SERVICE_ACCOUNT_B64: data.GOOGLE_SERVICE_ACCOUNT_B64,
    EXPENSES_CHANNEL_ID: data.EXPENSES_CHANNEL_ID,
    EXPENSE_LOG_CHANNEL_ID: data.EXPENSE_LOG_CHANNEL_ID,
    FINANCIAL_MANAGER_USER_ID: data.FINANCIAL_MANAGER_USER_ID,
    PORT: Number.isFinite(port) ? port : 3000,
    NODE_ENV: data.NODE_ENV,
    LOG_LEVEL: data.LOG_LEVEL,
  });
}
