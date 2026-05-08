/**
 * Tests for `shouldShowExitNotice` — the policy that decides whether to
 * render the "Agent process exited" banner in <AgentSessionView>.
 *
 * Claude's `--print` subprocess exits cleanly (code 0) after every turn —
 * spawn-per-turn is the documented Claude SDK pattern.  So code-0 exits
 * during an active conversation are *normal* and must NOT show the notice;
 * showing them would have the UI flicker "exited" between every reply.
 */
import { describe, it, expect } from "vitest";
import { shouldShowExitNotice } from "../agent/AgentSessionView";

describe("shouldShowExitNotice", () => {
  it("hides a clean code-0 exit during an active conversation", () => {
    expect(shouldShowExitNotice({ code: 0, signal: null }, 4)).toBe(false);
  });

  it("shows a clean exit when no messages have been exchanged yet", () => {
    // Subprocess died before the user even got to send anything — that's
    // worth surfacing because the agent is unusable.
    expect(shouldShowExitNotice({ code: 0, signal: null }, 0)).toBe(true);
  });

  it("shows a non-zero exit code regardless of conversation length", () => {
    expect(shouldShowExitNotice({ code: 1, signal: null }, 12)).toBe(true);
    expect(shouldShowExitNotice({ code: 137, signal: null }, 0)).toBe(true);
  });

  it("shows a signal-driven exit regardless of code", () => {
    expect(shouldShowExitNotice({ code: 0, signal: "SIGTERM" }, 8)).toBe(true);
    expect(shouldShowExitNotice({ code: null, signal: "SIGKILL" }, 0)).toBe(true);
  });

  it("treats a null code without a signal as a clean exit", () => {
    // Tauri reports `code: null` when the child died without a status —
    // mirror the code-0 behaviour: hide it during an active conversation.
    expect(shouldShowExitNotice({ code: null, signal: null }, 5)).toBe(false);
    expect(shouldShowExitNotice({ code: null, signal: null }, 0)).toBe(true);
  });
});
