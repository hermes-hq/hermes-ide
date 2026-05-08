/**
 * Phase 8 (v1.0.0 redesign) — SessionList close-button tooltip.
 *
 * Tests the tiny pure helper that drives the close-button title attribute.
 * Mode-conditional: agent → "End conversation", terminal/undefined →
 * "Close session".
 */
import { describe, expect, it } from "vitest";
import { sessionCloseTitle } from "../components/SessionList";

describe("sessionCloseTitle (Phase 8)", () => {
  it("returns 'End conversation' for agent mode", () => {
    expect(sessionCloseTitle("agent")).toBe("End conversation");
  });

  it("returns 'Close session' for terminal mode", () => {
    expect(sessionCloseTitle("terminal")).toBe("Close session");
  });

  it("defaults to 'Close session' for undefined mode (legacy / unmigrated sessions)", () => {
    expect(sessionCloseTitle(undefined)).toBe("Close session");
  });
});
