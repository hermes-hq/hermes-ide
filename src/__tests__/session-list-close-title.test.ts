// @vitest-environment jsdom
/**
 * Phase 8 (v1.0.0 redesign) — SessionList close-button tooltip.
 *
 * Tests the tiny pure helper that drives the close-button title attribute.
 * Mode-conditional: agent → "End conversation", terminal/undefined →
 * "Close session".
 */
import { describe, expect, it } from "vitest";
import { fillCutLineTitle, sessionCloseLabel, sessionCloseTitle } from "../components/SessionList";
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

// NEWCOMER-08 / LEAD-14 — the row's × names the session it closes, so a
// screen reader tells eight "Close session" buttons apart.
describe("sessionCloseLabel", () => {
  it("names the session", () => {
    expect(sessionCloseLabel("terminal", "api: fix login", translate)).toBe("Close session api: fix login");
    expect(sessionCloseLabel(undefined, "web: i18n", translate)).toBe("Close session web: i18n");
    expect(sessionCloseLabel("agent", "notes", translate)).toBe("End conversation notes");
  });

  it("falls back to the plain words for a session with no name", () => {
    expect(sessionCloseLabel("terminal", "   ", translate)).toBe("Close session");
  });
});

describe("fillCutLineTitle", () => {
  const line = (scroll: number, client: number, text: string, child?: { scroll: number; client: number }) => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollWidth", { value: scroll });
    Object.defineProperty(el, "clientWidth", { value: client });
    el.textContent = text;
    if (child) {
      const c = document.createElement("span");
      Object.defineProperty(c, "scrollWidth", { value: child.scroll });
      Object.defineProperty(c, "clientWidth", { value: child.client });
      el.appendChild(c);
    }
    return el;
  };

  it("gives a cut line all of its text as its tooltip, and none when it fits", () => {
    const cut = line(300, 200, "idle   39 MB  now  ≈$12.34");
    fillCutLineTitle({ currentTarget: cut });
    expect(cut.title).toBe("idle 39 MB now ≈$12.34");
    const ellipsis = line(200, 200, "idle 39 MB", { scroll: 60, client: 20 });
    fillCutLineTitle({ currentTarget: ellipsis });
    expect(ellipsis.title).toBe("idle 39 MB");
    const fits = line(200, 200, "idle");
    fits.title = "stale";
    fillCutLineTitle({ currentTarget: fits });
    expect(fits.hasAttribute("title")).toBe(false);
  });
});
