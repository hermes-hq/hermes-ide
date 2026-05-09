/**
 * Pure helpers for bridge runtime/lifecycle concerns — kept separate
 * from `canUseToolHelpers.mjs` (which is about tool permissions) so
 * each module has a tight focus and a unit test.
 */

/**
 * Build a once-only latch.  Calling `.resolve()` after the first call
 * is a guaranteed no-op — the underlying Promise is already settled,
 * but the explicit guard makes the intent obvious to a reader and
 * prevents subtle bugs if the implementation ever switches to a
 * different signalling primitive.
 *
 * Used in the bridge to mark "first SDK init event seen" so the
 * UserPromptSubmit hook can wait for it before injecting the runtime
 * digest, while the for-await loop fires `.resolve()` on every init
 * event without worrying about double-resolution.
 *
 * @returns {{ promise: Promise<void>, resolve: () => void, settled: () => boolean }}
 */
export function createIdempotentLatch() {
  let _resolve;
  const promise = new Promise((r) => { _resolve = r; });
  let settled = false;
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      _resolve();
    },
    settled: () => settled,
  };
}

/**
 * Build a control-op dispatcher that buffers operations arriving
 * before the bridge is ready to handle them, then drains the queue
 * once `markReady()` is called.
 *
 * Why this exists: there's a tiny window between the bridge starting
 * to read stdin (so it can begin buffering control ops) and assigning
 * the SDK's `queryHandle`.  A `setModel` op arriving in that window
 * would otherwise be silently dropped.  In practice the window is
 * microseconds, but the bug it would cause (model picker reverting on
 * the next turn) is hard to debug — easier to handle correctly.
 *
 * @template TOp
 * @param {(op: TOp) => Promise<unknown> | unknown} handler  Invoked once the dispatcher is marked ready.
 * @returns {{
 *   dispatch: (op: TOp) => Promise<void>,
 *   markReady: () => Promise<void>,
 *   isReady: () => boolean,
 *   pending: () => number,
 * }}
 */
export function createControlOpBuffer(handler) {
  const queue = [];
  let ready = false;

  return {
    /** Dispatch (or buffer) a control op. */
    dispatch: async (op) => {
      if (!ready) {
        queue.push(op);
        return;
      }
      await handler(op);
    },
    /** Mark the dispatcher ready and drain the buffered queue in order. */
    markReady: async () => {
      if (ready) return;
      ready = true;
      const drained = queue.splice(0);
      for (const op of drained) {
        // Awaited sequentially: control ops are stateful (setModel
        // followed by setPermissionMode shouldn't race), so preserving
        // arrival order matters.
        await handler(op);
      }
    },
    isReady: () => ready,
    pending: () => queue.length,
  };
}
