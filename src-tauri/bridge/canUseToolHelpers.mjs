/**
 * Pure helpers for the bridge's `canUseTool` callback and SDK option
 * derivation.
 *
 * Extracted into a separate module so the host-decision normalization,
 * permission-option shaping, and the canUseTool factory all have unit
 * tests (the bridge entry point is not directly importable — it has
 * top-level argv parsing and an `await main()`).
 */

/**
 * Normalize a decision returned by the host into the exact shape the
 * SDK's canUseTool callback expects.
 *
 * Background — the SDK's Zod schema requires the `allow` decision
 * shape to be `{ behavior: "allow", updatedInput: <record> }`.  When
 * the host approves WITHOUT editing the tool input, the bridge must
 * echo the ORIGINAL input back as `updatedInput` — otherwise the SDK
 * throws `ZodError("expected record, received undefined")` and the
 * tool call silently fails (this was the v1 plan-mode "Send does
 * nothing" bug).
 *
 * @param {unknown} decision           Raw value the host wrote on stdin.
 * @param {unknown} originalInput      The tool's original input (echoed
 *                                     when the host approves without edits).
 * @returns {{behavior: "allow", updatedInput: unknown} | {behavior: "deny", message: string}}
 */
export function normalizeBridgeAllowDecision(decision, originalInput) {
  if (!decision || typeof decision !== "object") {
    return { behavior: "deny", message: "host returned invalid decision" };
  }
  const d = /** @type {Record<string, unknown>} */ (decision);
  if (d.behavior === "allow") {
    const updatedInput =
      d.updatedInput && typeof d.updatedInput === "object"
        ? d.updatedInput
        : originalInput;
    return { behavior: "allow", updatedInput };
  }
  return {
    behavior: "deny",
    message: typeof d.message === "string" ? d.message : "user declined",
  };
}

/**
 * Build the `canUseTool` callback the SDK invokes when a tool is about
 * to run.  The bridge writes a `_hermes_perm_request` envelope on
 * stdout and waits for the host to write a `_hermes_perm_response` on
 * stdin (parked in `permPending`).
 *
 * The returned function honours the SDK's abort signal — when the
 * agent is aborted mid-prompt (user hits stop, parent context cancels,
 * etc.) the pending request is settled with a deny so the SDK doesn't
 * hang waiting on a host that may never reply.  Without this, the
 * promise queued in `permPending` would block until SIGTERM and the
 * SDK's cleanup phase would stall.
 *
 * @template T
 * @param {object} deps
 * @param {{ write: (chunk: string) => unknown }} deps.stdout         Where to send the perm-request envelope.
 * @param {Map<string, { resolve: (decision: unknown) => void }>} deps.permPending  Pending-request registry; the stdin reader
 *                                                                                  resolves entries here when the host responds.
 * @param {() => string} deps.idGen                                                  Generates a unique request id per call.
 * @param {(decision: unknown, originalInput: unknown) => unknown} [deps.normalize]  Decision normalizer (defaults to {@link normalizeBridgeAllowDecision}).
 * @returns {(toolName: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>}
 */
export function createCanUseToolHandler({
  stdout,
  permPending,
  idGen,
  normalize = normalizeBridgeAllowDecision,
}) {
  return async function canUseTool(toolName, input, options) {
    const signal = options && options.signal;
    // Short-circuit when the signal is already aborted: don't even bother
    // bothering the host for a decision that will be discarded.
    if (signal && signal.aborted) {
      return normalize({ behavior: "deny", message: "aborted" }, input);
    }
    const id = idGen();
    const decision = await new Promise((resolve) => {
      // Single-shot resolver — first caller wins.  Prevents a double
      // resolve when the host's response and an abort race each other.
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        permPending.delete(id);
        resolve(value);
      };
      permPending.set(id, { resolve: settle });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => settle({ behavior: "deny", message: "aborted" }),
          { once: true },
        );
      }

      stdout.write(
        JSON.stringify({ type: "_hermes_perm_request", id, toolName, input }) + "\n",
      );
    });
    return normalize(decision, input);
  };
}

/**
 * Derive the permission-related slice of the SDK options from the
 * bridge's CLI flags.
 *
 * The SDK requires `allowDangerouslySkipPermissions: true` to be set
 * alongside `permissionMode: "bypassPermissions"` (see sdk.d.ts:1490).
 * Setting only the mode without the boolean leaves the SDK in a state
 * where it may refuse to actually bypass — surfacing as confusing
 * "permission denied" errors that the host UI cannot explain.
 *
 * @param {{ permissionMode?: string }} flags
 * @returns {{ permissionMode?: string, allowDangerouslySkipPermissions?: boolean }}
 */
export function buildPermissionOptions(flags) {
  const out = {};
  if (flags && typeof flags.permissionMode === "string") {
    out.permissionMode = flags.permissionMode;
    if (flags.permissionMode === "bypassPermissions") {
      out.allowDangerouslySkipPermissions = true;
    }
  }
  return out;
}
