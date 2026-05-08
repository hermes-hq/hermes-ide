/**
 * Pure helpers for the bridge's `canUseTool` callback.
 *
 * Extracted into a separate module so the host-decision normalization
 * has a unit test (the bridge entry point is not directly importable —
 * it has top-level argv parsing and an `await main()`).
 *
 * Background — the SDK's Zod schema requires the `allow` decision
 * shape to be `{ behavior: "allow", updatedInput: <record> }`.  When
 * the host approves WITHOUT editing the tool input, the bridge must
 * echo the ORIGINAL input back as `updatedInput` — otherwise the SDK
 * throws `ZodError("expected record, received undefined")` and the
 * tool call silently fails (this was the v1 plan-mode "Send does
 * nothing" bug).
 */

/**
 * Normalize a decision returned by the host into the exact shape the
 * SDK's canUseTool callback expects.
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
