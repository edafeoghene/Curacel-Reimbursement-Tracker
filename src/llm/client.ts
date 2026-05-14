// OpenRouter client wrapper.
//
// This file is the ONE place in the codebase that constructs an LLM request.
// Provider locking, retries, and the per-call 120s timeout all live here.
// Every other module calls `callLLM`.
//
// Default gateway is OpenRouter. Provider locking applies to OpenRouter
// only — set OPENROUTER_PROVIDERS to a comma-separated list (e.g. `z-ai`)
// or `*` / `any` to remove the lock. The default locks to `anthropic` per
// PLAN §6/§18, the production invariant.
//
// To point the client at a different OpenAI-compatible gateway (e.g.
// Google's Gemini compat endpoint), set OPENROUTER_BASE_URL. The
// `provider` field is skipped automatically whenever the base URL isn't
// OpenRouter — it's a no-op or 400 on every other gateway.

import OpenAI, { APIError } from "openai";

/**
 * Minimal shape the wrapper actually consumes from the OpenAI client. Tests
 * inject a stub matching this surface; production code passes the real
 * `OpenAI` instance, which is structurally compatible.
 */
export interface LLMClientLike {
  chat: {
    completions: {
      create: (
        body: Record<string, unknown>,
        opts: { signal: AbortSignal },
      ) => Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

export interface CallLLMOptions {
  /** Override the default model. Usually you don't. */
  model?: string;
  /** JSON-mode response. Default true for our use case. */
  jsonMode?: boolean;
  /** Optional max tokens. */
  maxTokens?: number;
  /** Optional abort signal for caller-side cancellation. */
  signal?: AbortSignal;
  /**
   * Test-only seam: inject a stand-in for the OpenAI/OpenRouter client.
   * Production callers omit this and the real lazy singleton is used.
   * Underscore prefix marks it as not part of the public API.
   */
  _clientFactory?: () => LLMClientLike;
}

export class LLMCallFailed extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LLMCallFailed";
    this.cause = cause;
  }
}

const PER_ATTEMPT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function getBaseUrl(): string {
  const fromEnv = process.env.OPENROUTER_BASE_URL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

function isOpenRouter(baseUrl: string): boolean {
  return baseUrl.startsWith("https://openrouter.ai");
}

let cachedClient: OpenAI | null = null;

/**
 * Lazy singleton. We don't construct at import time so that tests / other
 * modules that don't actually call the LLM don't blow up if env is unset.
 */
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new LLMCallFailed(
      "OPENROUTER_API_KEY is not set. Configure it in the environment before calling the LLM.",
    );
  }

  const baseUrl = getBaseUrl();
  // OpenRouter expects Referer/Title for attribution; other gateways
  // (Gemini compat, etc.) don't use them and may not appreciate them.
  const defaultHeaders = isOpenRouter(baseUrl)
    ? { "HTTP-Referer": "https://curacel.co", "X-Title": "Curacel Expense Bot" }
    : undefined;

  cachedClient = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  return cachedClient;
}

function getModel(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.OPENROUTER_MODEL;
  if (!fromEnv) {
    throw new LLMCallFailed(
      "OPENROUTER_MODEL is not set. Configure it in the environment before calling the LLM.",
    );
  }
  return fromEnv;
}

type ProviderConfig = { order: string[]; allow_fallbacks: false };

function getProviderConfig(): ProviderConfig | null {
  // Provider routing is OpenRouter-specific. If the client is pointed at any
  // other OpenAI-compatible gateway via OPENROUTER_BASE_URL (e.g. Gemini's
  // compat endpoint), the field is at best ignored — at worst rejected — so
  // skip it entirely. This also keeps the anthropic-lock default from
  // leaking to Gemini if OPENROUTER_PROVIDERS isn't set.
  if (!isOpenRouter(getBaseUrl())) return null;

  const raw = process.env.OPENROUTER_PROVIDERS;
  if (raw === undefined) {
    return { order: ["anthropic"], allow_fallbacks: false };
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "any") {
    return null;
  }
  const order = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (order.length === 0) return null;
  return { order, allow_fallbacks: false };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = err.status;
    if (typeof status === "number") {
      if (status === 429) return true;
      if (status >= 500 && status <= 599) return true;
    }
    return false;
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMCallFailed("Aborted by caller during backoff", signal.reason));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LLMCallFailed("Aborted by caller during backoff", signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Link an outer (caller) AbortSignal with our per-attempt timeout into a
 * single controller. If either fires, the request aborts.
 */
function makeLinkedController(outer: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let outerListener: (() => void) | null = null;
  if (outer) {
    if (outer.aborted) {
      clearTimeout(timer);
      controller.abort(outer.reason);
    } else {
      outerListener = () => controller.abort(outer.reason);
      outer.addEventListener("abort", outerListener, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (outer && outerListener) {
      outer.removeEventListener("abort", outerListener);
    }
  };

  return { controller, cleanup };
}

/**
 * The MUST-HAVE wrapper. Every LLM call in the codebase goes through this.
 * Provider lock (`provider.order: ["anthropic"], allow_fallbacks: false`) is
 * applied here and nowhere else.
 *
 * Returns the assistant message string content. Throws `LLMCallFailed` on
 * exhausted retries, non-retryable errors, abort, or empty response.
 */
export async function callLLM(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: CallLLMOptions,
): Promise<string> {
  // The real OpenAI client and our test stub both satisfy the surface we use,
  // but the SDK's `create` is overloaded so its concrete type is not directly
  // assignable to our minimal `LLMClientLike`. Narrow through `unknown`.
  const client: LLMClientLike = options?._clientFactory
    ? options._clientFactory()
    : (getClient() as unknown as LLMClientLike);
  const model = getModel(options?.model);
  const jsonMode = options?.jsonMode ?? true;
  const providerConfig = getProviderConfig();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    const { controller, cleanup } = makeLinkedController(
      options?.signal,
      PER_ATTEMPT_TIMEOUT_MS,
    );

    try {
      const response = await client.chat.completions.create(
        {
          model,
          messages,
          ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
          ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          // OpenRouter-specific provider lock — not in OpenAI's body schema, but
          // structurally fine via LLMClientLike's `Record<string, unknown>` body.
          ...(providerConfig ? { provider: providerConfig } : {}),
        },
        { signal: controller.signal },
      );

      const content = response.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new LLMCallFailed(
          "LLM returned empty or missing content in choices[0].message.content",
        );
      }
      return content;
    } catch (err) {
      lastError = err;

      // Caller-initiated abort: do not retry.
      if (options?.signal?.aborted) {
        throw new LLMCallFailed("LLM call aborted by caller", err);
      }

      // Already an LLMCallFailed (e.g. empty content) — surface as-is, don't retry.
      if (err instanceof LLMCallFailed) {
        throw err;
      }

      // Decide whether to retry. If our OWN per-attempt timer aborted the
      // request (controller aborted, caller's signal didn't), treat that as
      // transient and retry — vision calls to slower providers (e.g. GLM)
      // can exceed the previous 30s budget without being actually broken.
      // Caller-initiated aborts are filtered out above and never reach here.
      const isOurTimeout = controller.signal.aborted && !options?.signal?.aborted;
      const canRetry = isOurTimeout || isRetryable(err);
      const isLastAttempt = attempt === RETRY_BACKOFF_MS.length - 1;

      if (!canRetry || isLastAttempt) {
        const status =
          err instanceof APIError && typeof err.status === "number" ? ` (status ${err.status})` : "";
        throw new LLMCallFailed(
          `LLM call failed${status}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      // Backoff before next attempt. Honor outer signal during sleep.
      await sleep(RETRY_BACKOFF_MS[attempt]!, options?.signal);
    } finally {
      cleanup();
    }
  }

  // Defensive — loop above always either returns or throws.
  throw new LLMCallFailed(
    `LLM call exhausted retries without an explicit error`,
    lastError,
  );
}

/**
 * Test-only hook: clear the lazy singleton so a re-read of process.env takes
 * effect. Not part of the public runtime API.
 */
export function __resetClientForTests(): void {
  cachedClient = null;
}
