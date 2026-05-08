/**
 * Phase 8 (v1.0.0 redesign) — CloseSessionDialog mode-conditional copy.
 *
 * Tests the tiny pure helpers that drive the dialog title, body, and confirm
 * button label depending on whether the session being closed is in `agent`
 * mode (Claude conversation) or `terminal` mode (shell PTY).
 */
import { describe, expect, it } from "vitest";
import {
  closeSessionDialogCopy,
  closeSessionDialogTitle,
  closeSessionDialogConfirmLabel,
} from "../components/CloseSessionDialog";

describe("closeSessionDialogCopy (Phase 8)", () => {
  it("returns the agent-mode body for 'agent'", () => {
    expect(closeSessionDialogCopy("agent")).toBe(
      "This will end the conversation with Claude.",
    );
  });

  it("returns the terminal-mode body for 'terminal'", () => {
    expect(closeSessionDialogCopy("terminal")).toBe(
      "This will terminate the running terminal session.",
    );
  });
});

describe("closeSessionDialogTitle (Phase 8)", () => {
  it("agent-mode title is 'End conversation?'", () => {
    expect(closeSessionDialogTitle("agent")).toBe("End conversation?");
  });

  it("terminal-mode title is 'Close session?'", () => {
    expect(closeSessionDialogTitle("terminal")).toBe("Close session?");
  });
});

describe("closeSessionDialogConfirmLabel (Phase 8)", () => {
  it("agent-mode confirm label is 'End conversation'", () => {
    expect(closeSessionDialogConfirmLabel("agent")).toBe("End conversation");
  });

  it("terminal-mode confirm label is 'Close session'", () => {
    expect(closeSessionDialogConfirmLabel("terminal")).toBe("Close session");
  });
});
