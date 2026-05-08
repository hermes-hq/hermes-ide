/**
 * Bridge `canUseTool` decision normalization.
 *
 * Regression coverage for the v1 plan-mode "Send does nothing" bug:
 *
 *   The SDK's Zod schema for the `canUseTool` callback's allow
 *   response requires `updatedInput` to be a record on every call.
 *   When the host approves WITHOUT editing input (e.g. accepting a
 *   plan or answering an AskUserQuestion via the perm-response
 *   channel), the bridge must ECHO the original input back as
 *   `updatedInput`.  Skipping the echo throws
 *
 *     ZodError: "expected record, received undefined"
 *
 *   and the tool call silently fails — the user sees nothing happen
 *   when they click Send.
 *
 * The helper is in plain ESM (.mjs) so vitest can import it directly.
 */
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import { normalizeBridgeAllowDecision } from "../../src-tauri/bridge/canUseToolHelpers.mjs";

describe("normalizeBridgeAllowDecision (REGRESSION: SDK ZodError on allow without updatedInput)", () => {
  const ORIG_INPUT = { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [] }] };

  it("echoes original input as updatedInput when host approves without edits", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "allow" }, ORIG_INPUT);
    expect(result).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("uses the host-supplied updatedInput when present (AskUserQuestion answers flow)", () => {
    const edited = { ...ORIG_INPUT, answers: { "Q?": "yes" } };
    const result = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: edited },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: edited });
  });

  it("falls back to original input when updatedInput is null", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: null },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("falls back to original input when updatedInput is a non-object (string/number)", () => {
    const r1 = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: "garbage" },
      ORIG_INPUT,
    );
    expect(r1).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });

    const r2 = normalizeBridgeAllowDecision(
      { behavior: "allow", updatedInput: 42 },
      ORIG_INPUT,
    );
    expect(r2).toEqual({ behavior: "allow", updatedInput: ORIG_INPUT });
  });

  it("deny → behavior=deny + custom message (ExitPlanMode reject feedback flow)", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "deny", message: "rethink the migration" },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "deny", message: "rethink the migration" });
  });

  it("deny without message → defaults to 'user declined'", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "deny" }, ORIG_INPUT);
    expect(result).toEqual({ behavior: "deny", message: "user declined" });
  });

  it("deny with non-string message → safely defaults", () => {
    const result = normalizeBridgeAllowDecision(
      { behavior: "deny", message: 12345 },
      ORIG_INPUT,
    );
    expect(result).toEqual({ behavior: "deny", message: "user declined" });
  });

  it("invalid decision (null/string/wrong type) → deny with safe message", () => {
    expect(normalizeBridgeAllowDecision(null, ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
    expect(normalizeBridgeAllowDecision("garbage", ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
    expect(normalizeBridgeAllowDecision(undefined, ORIG_INPUT)).toEqual({
      behavior: "deny",
      message: "host returned invalid decision",
    });
  });

  it("decision with unknown behavior → coerced to deny (defensive)", () => {
    const result = normalizeBridgeAllowDecision({ behavior: "ask" }, ORIG_INPUT);
    expect(result.behavior).toBe("deny");
  });

  it("does NOT mutate the original input", () => {
    const input = { questions: [{ question: "Q?" }] };
    const before = JSON.stringify(input);
    normalizeBridgeAllowDecision({ behavior: "allow" }, input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
