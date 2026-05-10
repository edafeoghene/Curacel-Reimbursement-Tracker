// callLLM is the single chokepoint for every OpenRouter request in the bot,
// so PLAN.md §6 and §18 require it to:
//
//   1. ALWAYS attach `provider: { order: ["anthropic"], allow_fallbacks: false }`
//      to the request body. Forgetting this is the highest-risk regression in
//      the codebase — it would silently fail over to OpenAI/whatever-default.
//   2. Retry on 429 / 5xx with backoff and surface LLMCallFailed only after
//      exhausting attempts.
//   3. NOT retry on 4xx other than 429 — those are deterministic failures.
//   4. Pass an AbortSignal so a 30s per-attempt timeout can fire.
//
// We dependency-inject a fake client through the underscore-prefixed
// `_clientFactory` option exposed on CallLLMOptions. Fake timers fast-forward
// the backoff sleeps so retry tests don't burn real seconds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "openai";
import {
  callLLM,
  LLMCallFailed,
  type LLMClientLike,
} from "../../src/llm/client.js";

type CreateFn = LLMClientLike["chat"]["completions"]["create"];

interface FakeClient extends LLMClientLike {
  chat: {
    completions: {
      create: ReturnType<typeof vi.fn> & CreateFn;
    };
  };
}

function makeFakeClient(create: CreateFn): FakeClient {
  const spy = vi.fn(create) as ReturnType<typeof vi.fn> & CreateFn;
  return { chat: { completions: { create: spy } } };
}

function okResponse(content = '{"is_expense":false,"confidence":0.9,"items":[],"notes":""}') {
  return { choices: [{ message: { content } }] };
}

function apiError(status: number, message = `HTTP ${status}`): APIError {
  // The real OpenAI SDK throws APIError subclasses; isRetryable() checks
  // `instanceof APIError` and reads `.status`. A direct APIError instance
  // satisfies both.
  return new APIError(status, undefined, message, undefined);
}

beforeEach(() => {
  // Backoff is [1s, 2s, 4s] — fake timers let us advance instantly without
  // letting microtask queues silently re-enter real time.
  vi.useFakeTimers();
  // Production callLLM reads OPENROUTER_MODEL from env. Set it so we don't
  // depend on shell state. (When _clientFactory is injected the OPENROUTER_API_KEY
  // path is skipped entirely.)
  process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Run callLLM with fake timers in play, draining each scheduled backoff so the
 * promise can settle. We can't simply `await callLLM(...)` because the inner
 * `setTimeout`-based sleep would never fire under fake timers without an
 * explicit `vi.advanceTimersByTimeAsync`.
 */
async function runWithFakeBackoff<T>(promise: Promise<T>): Promise<T> {
  // Drain pending timers a few times. Three attempts × max 4s backoff is well
  // under 20s of virtual time; we drain in chunks to also flush microtasks
  // between throws.
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 10 && !settled; i++) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(5_000);
  }
  return promise;
}

describe("callLLM provider lock (PLAN §6/§18 — non-negotiable invariant)", () => {
  it("attaches provider:{order:['anthropic'], allow_fallbacks:false} on the FIRST call", async () => {
    const client = makeFakeClient(async () => okResponse());

    await callLLM([{ role: "user", content: "hi" }], { _clientFactory: () => client });

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const [body] = client.chat.completions.create.mock.calls[0]!;
    expect(body).toMatchObject({
      provider: { order: ["anthropic"], allow_fallbacks: false },
    });
  });

  it("attaches the provider lock on EVERY retry attempt, not just the first", async () => {
    let calls = 0;
    const client = makeFakeClient(async () => {
      calls += 1;
      if (calls < 3) throw apiError(503);
      return okResponse();
    });

    await runWithFakeBackoff(
      callLLM([{ role: "user", content: "hi" }], { _clientFactory: () => client }),
    );

    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    // Every single body, including retries, must carry the provider lock.
    for (const [body] of client.chat.completions.create.mock.calls) {
      expect(body).toMatchObject({
        provider: { order: ["anthropic"], allow_fallbacks: false },
      });
    }
  });

  it("does not allow allow_fallbacks:true to leak in (deep equality of provider field)", async () => {
    const client = makeFakeClient(async () => okResponse());
    await callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client });

    const [body] = client.chat.completions.create.mock.calls[0]!;
    // Strict equality, not partial — the provider object must be exactly this
    // shape. A future refactor that adds `allow_fallbacks: true` would fail.
    expect((body as { provider: unknown }).provider).toEqual({
      order: ["anthropic"],
      allow_fallbacks: false,
    });
  });
});

describe("callLLM retry behavior", () => {
  it("retries on 429 and eventually succeeds", async () => {
    let calls = 0;
    const client = makeFakeClient(async () => {
      calls += 1;
      if (calls === 1) throw apiError(429);
      return okResponse('{"is_expense":true,"confidence":0.95,"items":[],"notes":""}');
    });

    const result = await runWithFakeBackoff(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    );

    expect(result).toContain('"is_expense":true');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 and eventually succeeds", async () => {
    let calls = 0;
    const client = makeFakeClient(async () => {
      calls += 1;
      if (calls < 2) throw apiError(500);
      return okResponse();
    });

    await runWithFakeBackoff(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    );

    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and surfaces LLMCallFailed after exhausting attempts", async () => {
    const client = makeFakeClient(async () => {
      throw apiError(503);
    });

    await expect(
      runWithFakeBackoff(
        callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
      ),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    // RETRY_BACKOFF_MS has length 3, so we expect exactly 3 attempts.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("the LLMCallFailed surfaced after exhausted retries embeds the underlying APIError", async () => {
    const lastError = apiError(503, "upstream is unhappy");
    let calls = 0;
    const client = makeFakeClient(async () => {
      calls += 1;
      // Throw a fresh-but-equivalent error each time except the last, which
      // we assert wraps with status info in the message.
      if (calls < 3) throw apiError(503);
      throw lastError;
    });

    let caught: unknown;
    try {
      await runWithFakeBackoff(
        callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LLMCallFailed);
    expect((caught as LLMCallFailed).message).toContain("status 503");
    expect((caught as LLMCallFailed).cause).toBe(lastError);
  });
});

describe("callLLM non-retryable errors", () => {
  it("does NOT retry on 400 — surfaces LLMCallFailed after exactly one attempt", async () => {
    const client = makeFakeClient(async () => {
      throw apiError(400, "bad request");
    });

    await expect(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401", async () => {
    const client = makeFakeClient(async () => {
      throw apiError(401, "unauthorized");
    });

    await expect(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404", async () => {
    const client = makeFakeClient(async () => {
      throw apiError(404, "not found");
    });

    await expect(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("surfaces LLMCallFailed (without retry) when the model returns empty content", async () => {
    const client = makeFakeClient(async () => ({
      choices: [{ message: { content: "" } }],
    }));

    await expect(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});

describe("callLLM timeout / abort plumbing", () => {
  it("passes an AbortSignal as the second arg to chat.completions.create", async () => {
    const client = makeFakeClient(async () => okResponse());

    await callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client });

    const [, opts] = client.chat.completions.create.mock.calls[0]!;
    expect(opts).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // It must not be pre-aborted at the moment of the call.
    expect(opts.signal.aborted).toBe(false);
  });

  it("a fresh AbortSignal is created per attempt (not reused across retries)", async () => {
    const seenSignals: AbortSignal[] = [];
    let calls = 0;
    const client = makeFakeClient(async (_body, opts) => {
      seenSignals.push(opts.signal);
      calls += 1;
      if (calls < 2) throw apiError(500);
      return okResponse();
    });

    await runWithFakeBackoff(
      callLLM([{ role: "user", content: "x" }], { _clientFactory: () => client }),
    );

    expect(seenSignals.length).toBe(2);
    // Each attempt's per-attempt timeout uses its own controller, so the two
    // signals must be distinct objects.
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
  });

  it("an outer abort signal aborts the per-attempt signal too", async () => {
    const outer = new AbortController();
    let captured: AbortSignal | undefined;
    const client = makeFakeClient(async (_body, opts) => {
      captured = opts.signal;
      // Trip the outer signal mid-flight; the linked inner signal must follow.
      outer.abort(new Error("caller cancelled"));
      // Throw something so callLLM exits the try.
      throw apiError(500);
    });

    await expect(
      callLLM([{ role: "user", content: "x" }], {
        _clientFactory: () => client,
        signal: outer.signal,
      }),
    ).rejects.toBeInstanceOf(LLMCallFailed);

    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
  });
});
