// OpenRouter client wrapper.
//
// This file is the ONE place in the codebase that constructs an LLM request.
// Provider locking (anthropic only, no fallbacks), retries, and the per-call
// 30s timeout all live here. Every other module calls `callLLM`.
//
// PLAN.md §6 + §18 — do not move this logic anywhere else.

import OpenAI, { APIError } from "openai";

export interface CallLLMOptions {
  /** Override the default model. Usually you don't. */
  model?: string;
  /** JSON-mode response. Default true for our use case. */
  jsonMode?: boolean;
  /** Optional max tokens. */
  maxTokens?: number;
  /** Optional abort signal for caller-side cancellation. */
  signal?: AbortSignal;
}

export class LLMCallFailed extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LLMCallFailed";
    this.cause = cause;
  }
}

const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

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

  cachedClient = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://curacel.co",
      "X-Title": "Curacel Expense Bot",
    },
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
  const client = getClient();
  const model = getModel(options?.model);
  const jsonMode = options?.jsonMode ?? true;

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
          // @ts-expect-error provider is OpenRouter-specific
          provider: { order: ["anthropic"], allow_fallbacks: false },
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

      // Decide whether to retry.
      const canRetry = isRetryable(err);
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
