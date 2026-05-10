import { describe, expect, it } from "vitest";
import {
  enqueueWrite,
  pendingWriteCount,
  SheetsWriteFailed,
} from "../../src/sheets/queue.js";

// Test-only fast backoff so retry tests don't sleep for seconds.
const FAST_BACKOFF = [1, 2, 4] as const;

// A no-op sleep keeps retry tests deterministic and instant. Using
// maxJitterMs:0 alongside ensures the result schedule is observable.
const NO_SLEEP = { backoffMs: FAST_BACKOFF, maxJitterMs: 0, _sleep: async () => {} };

/** Build a synthetic googleapis-shaped HTTP error. */
function makeHttpError(status: number, message = `HTTP ${status}`): Error & {
  code: number;
  status: number;
} {
  const err = new Error(message) as Error & { code: number; status: number };
  err.code = status;
  err.status = status;
  return err;
}

/** Build a synthetic Node network error (e.g. ECONNRESET). */
function makeNetError(code: string, message = code): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("enqueueWrite", () => {
  it("serializes writes in submission order", async () => {
    const order: number[] = [];

    const makeJob = (id: number, ms: number) => async () => {
      // Sleep first; if writes weren't serialized, ID 1 would push last
      // (because it sleeps longest) instead of first.
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(id);
      return id;
    };

    const promises = [
      enqueueWrite(makeJob(1, 30)),
      enqueueWrite(makeJob(2, 5)),
      enqueueWrite(makeJob(3, 20)),
      enqueueWrite(makeJob(4, 1)),
      enqueueWrite(makeJob(5, 10)),
    ];

    const results = await Promise.all(promises);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns the inner function's resolved value", async () => {
    const result = await enqueueWrite(async () => "hello");
    expect(result).toBe("hello");
  });

  it("propagates errors to the caller without poisoning the chain", async () => {
    const order: string[] = [];

    const failing = enqueueWrite(async () => {
      order.push("failing-start");
      throw new Error("boom");
    });

    const after = enqueueWrite(async () => {
      order.push("after-start");
      return "after-ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("after-ok");
    expect(order).toEqual(["failing-start", "after-start"]);
  });

  it("executes jobs strictly sequentially (no overlap)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const job = (ms: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
    };

    await Promise.all([
      enqueueWrite(job(10)),
      enqueueWrite(job(10)),
      enqueueWrite(job(10)),
      enqueueWrite(job(10)),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("tracks pending writes via pendingWriteCount()", async () => {
    const start = pendingWriteCount();
    const p = enqueueWrite(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(pendingWriteCount()).toBeGreaterThan(start);
    await p;
    // After settle, the counter is back to (or below) the starting value.
    expect(pendingWriteCount()).toBeLessThanOrEqual(start);
  });
});

describe("enqueueWrite retry-with-backoff", () => {
  it("retries on a synthetic 503 and resolves on the second attempt", async () => {
    let attempts = 0;
    const result = await enqueueWrite(async () => {
      attempts += 1;
      if (attempts === 1) throw makeHttpError(503);
      return "ok";
    }, NO_SLEEP);

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries on 429 and 500 and resolves on the third attempt", async () => {
    let attempts = 0;
    const result = await enqueueWrite(async () => {
      attempts += 1;
      if (attempts === 1) throw makeHttpError(429, "rate limited");
      if (attempts === 2) throw makeHttpError(500);
      return 42;
    }, NO_SLEEP);

    expect(result).toBe(42);
    expect(attempts).toBe(3);
  });

  it("retries on ECONNRESET (network error)", async () => {
    let attempts = 0;
    const result = await enqueueWrite(async () => {
      attempts += 1;
      if (attempts === 1) throw makeNetError("ECONNRESET");
      return "recovered";
    }, NO_SLEEP);

    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  it("surfaces SheetsWriteFailed after 3 exhausted attempts on a transient error", async () => {
    let attempts = 0;
    const p = enqueueWrite(async () => {
      attempts += 1;
      throw makeHttpError(503, "still failing");
    }, NO_SLEEP);

    await expect(p).rejects.toBeInstanceOf(SheetsWriteFailed);
    expect(attempts).toBe(3);

    // The original error is preserved as `cause` for diagnostics.
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(SheetsWriteFailed);
      const swf = err as SheetsWriteFailed;
      expect(swf.cause).toBeDefined();
      expect((swf.cause as Error).message).toBe("still failing");
    }
  });

  it("does NOT retry on a 400 — propagates immediately", async () => {
    let attempts = 0;
    const original = makeHttpError(400, "bad request");
    const p = enqueueWrite(async () => {
      attempts += 1;
      throw original;
    }, NO_SLEEP);

    await expect(p).rejects.toBe(original);
    expect(attempts).toBe(1);
  });

  it("does NOT retry on a 404 — propagates immediately", async () => {
    let attempts = 0;
    const original = makeHttpError(404, "not found");
    const p = enqueueWrite(async () => {
      attempts += 1;
      throw original;
    }, NO_SLEEP);

    await expect(p).rejects.toBe(original);
    expect(attempts).toBe(1);
  });

  it("does NOT retry RowVersionConflict-shaped errors — propagates immediately", async () => {
    // Synthesize an error matching the RowVersionConflict shape from
    // src/sheets/tickets.ts. It carries no HTTP code, so the queue must
    // treat it as application-level and surface it on the first attempt.
    class RowVersionConflict extends Error {
      constructor(
        public readonly trackingId: string,
        public readonly expected: number,
        public readonly actual: number,
      ) {
        super(`RowVersionConflict on ticket ${trackingId}`);
        this.name = "RowVersionConflict";
      }
    }

    let attempts = 0;
    const original = new RowVersionConflict("T-123", 1, 2);
    const p = enqueueWrite(async () => {
      attempts += 1;
      throw original;
    }, NO_SLEEP);

    await expect(p).rejects.toBe(original);
    expect(attempts).toBe(1);
  });

  it("preserves serialization across retries (no overlap with the next task)", async () => {
    const events: string[] = [];

    // Task A fails once with a transient error, succeeds on retry.
    let aAttempts = 0;
    const a = enqueueWrite(async () => {
      aAttempts += 1;
      events.push(`a-attempt-${aAttempts}`);
      if (aAttempts === 1) throw makeHttpError(503);
      events.push("a-done");
      return "a";
    }, NO_SLEEP);

    // Task B is enqueued immediately after; it must not start until A
    // (including its retry) finishes.
    const b = enqueueWrite(async () => {
      events.push("b-start");
      events.push("b-done");
      return "b";
    }, NO_SLEEP);

    await Promise.all([a, b]);
    expect(events).toEqual([
      "a-attempt-1",
      "a-attempt-2",
      "a-done",
      "b-start",
      "b-done",
    ]);
    expect(aAttempts).toBe(2);
  });
});
