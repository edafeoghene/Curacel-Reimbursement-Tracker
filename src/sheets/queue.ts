// Serial write queue — every sheet mutation MUST go through enqueueWrite().
// Reads remain concurrent (per PLAN.md §11). The chain is intentionally
// process-local; running more than one bot instance at a time breaks the
// concurrency model (PLAN.md §11 "What this does NOT protect against").

let writeChain: Promise<void> = Promise.resolve();
let pending = 0;

/**
 * Append `fn` to the serial write chain. Returns a promise that resolves with
 * fn's value (or rejects with its error). Subsequent enqueued writes do NOT
 * see a poisoned chain even if `fn` throws.
 */
export function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  const result = writeChain.then(() => fn());
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
