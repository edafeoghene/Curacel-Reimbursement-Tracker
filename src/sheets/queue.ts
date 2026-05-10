// Serial write queue — every sheet mutation MUST go through enqueueWrite().
// Reads remain concurrent (per PLAN.md §11). The chain is intentionally
// process-local; running more than one bot instance at a time breaks the
// concurrency model (PLAN.md §11 "What this does NOT protect against").
//
// Each enqueued task is additionally wrapped in retry-with-backoff for
// transient Sheets API errors (429 / 5xx / network resets). Non-transient
// errors — including the application-level `RowVersionConflict` thrown by
// tickets.ts — propagate immediately without retry. Mirrors the LLM client
// retry policy in src/llm/client.ts (PLAN.md §6).

let writeChain: Promise<void> = Promise.resolve();
let pending = 0;

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const MAX_JITTER_MS = 250;

/**
 * Thrown after retries are exhausted on a transient Sheets API failure, or
 * propagated unchanged when a non-transient error surfaces from the task.
 * (Non-transient errors keep their original type; only the
 * exhausted-retry case is wrapped here.)
 */
export class SheetsWriteFailed extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SheetsWriteFailed";
    this.cause = cause;
  }
}

export interface EnqueueWriteOptions {
  /**
   * Override retry backoff schedule (ms per attempt). Length determines max
   * attempts. Used by tests to keep them fast; production callers should
   * leave this unset to get the safe default of [1000, 2000, 4000].
   */
  backoffMs?: readonly number[];
  /**
   * Override jitter ceiling (ms). Tests pass 0 for determinism; production
   * defaults to 250.
   */
  maxJitterMs?: number;
  /**
   * Test-only seam to make sleep synchronous / observable. Defaults to a
   * real setTimeout-based sleep.
   */
  _sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns true if `err` looks like a transient Sheets API failure worth
 * retrying. We treat the following as transient:
 *   - HTTP 429 (rate limited)
 *   - HTTP 5xx
 *   - Node network errors: ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN
 *
 * Anything else (including 4xx other than 429, application errors like
 * RowVersionConflict, and TypeErrors) is considered non-transient.
 *
 * The googleapis SDK throws GaxiosError with `code` set to the HTTP status
 * as a string OR number depending on the call path, and exposes
 * `response.status` as a number. We tolerate all three shapes.
 */
function isTransientSheetsError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;

  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };

  // Network / DNS errors come through as string codes.
  if (typeof e.code === "string") {
    if (
      e.code === "ECONNRESET" ||
      e.code === "ETIMEDOUT" ||
      e.code === "ENOTFOUND" ||
      e.code === "EAI_AGAIN"
    ) {
      return true;
    }
    // GaxiosError sometimes stringifies the HTTP status into `code`.
    const asNum = Number(e.code);
    if (Number.isFinite(asNum) && isTransientHttpStatus(asNum)) return true;
    return false;
  }

  if (typeof e.code === "number" && isTransientHttpStatus(e.code)) return true;
  if (typeof e.status === "number" && isTransientHttpStatus(e.status)) return true;
  if (
    typeof e.response?.status === "number" &&
    isTransientHttpStatus(e.response.status)
  ) {
    return true;
  }

  return false;
}

function isTransientHttpStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry<T>(
  fn: () => Promise<T>,
  options?: EnqueueWriteOptions,
): Promise<T> {
  const backoff = options?.backoffMs ?? RETRY_BACKOFF_MS;
  const maxJitter = options?.maxJitterMs ?? MAX_JITTER_MS;
  const sleep = options?._sleep ?? defaultSleep;

  let lastError: unknown = null;

  // Number of attempts = backoff.length. We sleep before each retry, not
  // after the final attempt. (Matches the LLM client.)
  const maxAttempts = backoff.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const canRetry = isTransientSheetsError(err);
      const isLastAttempt = attempt === maxAttempts - 1;

      if (!canRetry) {
        // Non-transient: propagate the original error untouched. This keeps
        // RowVersionConflict, TicketNotFoundError, 4xx, etc. as their
        // native types so callers' instanceof checks still work.
        throw err;
      }

      if (isLastAttempt) {
        throw new SheetsWriteFailed(
          `Sheets write failed after ${maxAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      const base = backoff[attempt]!;
      const jitter = maxJitter > 0 ? Math.floor(Math.random() * maxJitter) : 0;
      await sleep(base + jitter);
    }
  }

  // Defensive — loop above always returns or throws.
  throw new SheetsWriteFailed(
    `Sheets write exhausted retries without an explicit error`,
    lastError,
  );
}

/**
 * Append `fn` to the serial write chain. Returns a promise that resolves with
 * fn's value (or rejects with its error). Subsequent enqueued writes do NOT
 * see a poisoned chain even if `fn` throws.
 *
 * Each task is wrapped in retry-with-backoff for transient Sheets API
 * errors (429 / 5xx / network resets). Non-transient errors — including
 * `RowVersionConflict` from tickets.ts — propagate immediately. Retries
 * happen INSIDE the queue slot, so serialization is preserved across them.
 */
export function enqueueWrite<T>(
  fn: () => Promise<T>,
  options?: EnqueueWriteOptions,
): Promise<T> {
  pending += 1;
  const result = writeChain.then(() => runWithRetry(fn, options));
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  // Decrement the counter once this slot resolves (success or failure).
  result.then(
    () => {
      pending -= 1;
    },
    () => {
      pending -= 1;
    },
  );
  return result;
}

/** Diagnostic only. Number of writes currently queued or in flight. */
export function pendingWriteCount(): number {
  return pending;
}
