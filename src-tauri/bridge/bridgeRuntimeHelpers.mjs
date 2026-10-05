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
  // `draining` is true while `markReady()` is iterating the queue.
  // While draining, new dispatches MUST queue rather than short-circuit
  // through the immediate path — otherwise a `dispatch` arriving mid-drain
  // would jump ahead of already-queued ops and break the FIFO guarantee
  // the buffer was built to provide (see BUG-2).
  let draining = false;

  return {
    /** Dispatch (or buffer) a control op. */
    dispatch: async (op) => {
      if (!ready || draining) {
        queue.push(op);
        return;
      }
      await handler(op);
    },
    /**
     * Mark the dispatcher ready and drain the buffered queue in order.
     *
     * Drains every queued op even if individual handlers reject — control
     * ops are independent (setModel rejecting must NOT prevent a queued
     * setPermissionMode/interrupt from running).  Errors are accumulated
     * and surfaced as an `AggregateError` once the drain completes, so
     * callers learn about every failure rather than just the first.
     *
     * Idempotent: a second call is a no-op (matches the original
     * contract — `if (ready) return`).  We additionally ignore re-entry
     * while a drain is already in flight.
     */
    markReady: async () => {
      if (ready) return;
      ready = true;
      draining = true;
      const errors = [];
      try {
        // Loop on `queue.length` (not a one-shot `splice`) so that ops
        // dispatched during the drain — which now queue because
        // `draining === true` — are still processed in arrival order
        // before this method returns.  Awaited sequentially because
        // control ops are stateful (setModel followed by
        // setPermissionMode shouldn't race).
        while (queue.length > 0) {
          const op = queue.shift();
          try {
            await handler(op);
          } catch (err) {
            errors.push(err);
          }
        }
      } finally {
        draining = false;
      }
      if (errors.length > 0) {
        if (typeof AggregateError === "function") {
          throw new AggregateError(
            errors,
            `controlOpBuffer: ${errors.length} handler(s) failed during drain`,
          );
        }
        // Defensive fallback for runtimes without AggregateError (Node <16).
        const fallback = new Error(
          `controlOpBuffer: ${errors.length} handler(s) failed during drain`,
        );
        // @ts-ignore — attach the list so callers can still inspect it.
        fallback.errors = errors;
        throw fallback;
      }
    },
    isReady: () => ready,
    pending: () => queue.length,
  };
}

/**
 * Normalize a host stdin envelope into the SDKUserMessage shape the SDK
 * expects.  Old Hermes envelopes lack `parent_tool_use_id`; the SDK wants
 * null, not absent.  `session_id` falls back to the spawn-time id.
 *
 * `origin` (SDK 0.3.x provenance) is passed through only when the host
 * set it — the composer stamps `{ kind: "human" }` on typed messages.
 * The bridge never invents one: an envelope without `origin` stays
 * unattributed, which the SDK treats as not-human (fails closed).
 */
export function toSdkUserMessage(next, fallbackSessionId) {
  const sessionId = next.session_id ?? fallbackSessionId;
  return {
    type: "user",
    message: next.message,
    parent_tool_use_id: next.parent_tool_use_id ?? null,
    uuid: next.uuid,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(next.origin && typeof next.origin.kind === "string" ? { origin: next.origin } : {}),
  };
}

/**
 * Build the env for the Claude subprocess the SDK spawns.
 *
 * Claude Code only loads CLAUDE.md files from `--add-dir` folders when
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set.  Hermes passes
 * every attached folder as an additional directory, so we turn it on by
 * default — unless the user already set it (either way) in their env.
 *
 * @param {Record<string, string | undefined>} baseEnv
 * @param {string} clientApp
 * @returns {Record<string, string | undefined>}
 */
export function buildSdkEnv(baseEnv, clientApp) {
  return {
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    ...baseEnv,
    CLAUDE_AGENT_SDK_CLIENT_APP: clientApp,
  };
}

/**
 * Warnings the bridge expects and acts on by design, by code. They went to
 * stderr, and the Agent view showed them as an STDERR panel under the
 * conversation as if something were wrong.
 *
 *   CLAUDE_SDK_CAN_USE_TOOL_SHADOWED  the SDK notes that the tools in
 *     `allowedTools` (Hermes's own MCP tools and the task list) are approved
 *     without asking `canUseTool`. That is exactly why they are listed.
 */
export const EXPECTED_WARNING_CODES = new Set(["CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"]);

/**
 * Wraps `proc.emitWarning` so warnings with a code in `codes` are dropped
 * and every other warning is emitted as before. Returns a function that
 * puts the original back.
 *
 * @param {{ emitWarning: (...args: unknown[]) => void }} proc
 * @param {Set<string>} [codes]
 */
export function quietExpectedWarnings(proc, codes = EXPECTED_WARNING_CODES) {
  const original = proc.emitWarning;
  proc.emitWarning = function emitWarning(warning, ...rest) {
    // emitWarning(warning, { code }), emitWarning(warning, type, code), or an Error carrying .code.
    const options = rest[0];
    const code =
      (options && typeof options === "object" ? options.code : undefined) ??
      (typeof rest[1] === "string" ? rest[1] : undefined) ??
      (warning && typeof warning === "object" ? warning.code : undefined);
    if (typeof code === "string" && codes.has(code)) return;
    return original.call(this, warning, ...rest);
  };
  return () => {
    proc.emitWarning = original;
  };
}
