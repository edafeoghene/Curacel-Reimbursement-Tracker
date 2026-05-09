import { describe, expect, it } from "vitest";
import { enqueueWrite, pendingWriteCount } from "../../src/sheets/queue.js";

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
