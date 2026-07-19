/**
 * Phase 8 (v1.0.0 redesign) — SessionList close-button tooltip.
 *
 * Tests the tiny pure helper that drives the close-button title attribute.
 * Mode-conditional: agent → "End conversation", terminal/undefined →
 * "Close session".
 */
import { describe, expect, it } from "vitest";
import { sessionCloseTitle } from "../components/SessionList";
import { translate } from "../i18n/registry";

// The labels moved behind i18n keys — pass the real `translate` so the
// assertions also prove the keys exist in the English base pack.
describe("sessionCloseTitle (Phase 8)", () => {
  it("returns 'End conversation' for agent mode", () => {
    expect(sessionCloseTitle("agent", translate)).toBe("End conversation");
  });

  it("returns 'Close session' for terminal mode", () => {
    expect(sessionCloseTitle("terminal", translate)).toBe("Close session");
  });

  it("defaults to 'Close session' for undefined mode (legacy / unmigrated sessions)", () => {
    expect(sessionCloseTitle(undefined, translate)).toBe("Close session");
  });
});
