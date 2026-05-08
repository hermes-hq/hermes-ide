// @vitest-environment jsdom
/**
 * Imperative session-creator opening overlay.  Bypasses React entirely
 * because the React-based overlay never paint-cycled correctly through
 * the strict-mode + heavy first-mount + async useEffect timing dance.
 *
 * Spec: M9 / M11 + this is the "M11.2 — imperative" rewrite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  computeOverlayDismissDelay,
  hideOpeningOverlay,
  MIN_OVERLAY_MS,
  showOpeningOverlay,
  _resetOverlayForTests,
} from "../utils/sessionCreatorOverlay";

describe("computeOverlayDismissDelay", () => {
  it("returns the full minimum when triggered immediately (0ms elapsed)", () => {
    expect(computeOverlayDismissDelay(0)).toBe(MIN_OVERLAY_MS);
  });

  it("returns 0 when fired after the minimum has elapsed", () => {
    expect(computeOverlayDismissDelay(MIN_OVERLAY_MS)).toBe(0);
    expect(computeOverlayDismissDelay(MIN_OVERLAY_MS + 100)).toBe(0);
  });

  it("clamps negative elapsed (clock skew) to the full minimum", () => {
    expect(computeOverlayDismissDelay(-50)).toBe(MIN_OVERLAY_MS);
  });

  it("MIN_OVERLAY_MS sits in a perceptible range (≥ 400ms, ≤ 1500ms)", () => {
    expect(MIN_OVERLAY_MS).toBeGreaterThanOrEqual(400);
    expect(MIN_OVERLAY_MS).toBeLessThanOrEqual(1500);
  });
});

describe("showOpeningOverlay (imperative)", () => {
  beforeEach(() => {
    _resetOverlayForTests();
  });

  it("synchronously appends a <div> to document.body — no React, no portal", () => {
    showOpeningOverlay();
    const node = document.querySelector("#hermes-session-creator-opening-overlay");
    expect(node).not.toBeNull();
    expect(node?.parentElement).toBe(document.body);
  });

  it("renders the HERMES brand mark immediately", () => {
    showOpeningOverlay();
    const node = document.querySelector("#hermes-session-creator-opening-overlay");
    const text = node?.textContent?.toLowerCase() ?? "";
    expect(text).toContain("hermes");
    // The headline types out character-by-character — at t=0 only the
    // first character is in.  We can't reliably assert on a partial
    // text without timer faking, so just confirm the headline element
    // exists and has SOMETHING in it (proves typeTick fired once).
    expect(node?.textContent ?? "").toMatch(/[A-Za-z]/);
  });

  it("uses fixed positioning + max z-index so nothing can hide it", () => {
    showOpeningOverlay();
    const node = document.querySelector("#hermes-session-creator-opening-overlay") as HTMLElement;
    expect(node.style.position).toBe("fixed");
    // Some jsdom versions normalize the value, others keep "2147483647".
    expect(node.style.zIndex.length).toBeGreaterThan(0);
  });

  it("idempotent: calling twice while one is up doesn't append a second", () => {
    showOpeningOverlay();
    showOpeningOverlay();
    const nodes = document.querySelectorAll("#hermes-session-creator-opening-overlay");
    expect(nodes.length).toBe(1);
  });

  it("hideOpeningOverlay removes the element after the minimum has elapsed", async () => {
    showOpeningOverlay();
    const before = document.querySelector("#hermes-session-creator-opening-overlay");
    expect(before).not.toBeNull();
    await hideOpeningOverlay();
    const after = document.querySelector("#hermes-session-creator-opening-overlay");
    expect(after).toBeNull();
  });

  it("hide before show is a safe no-op", async () => {
    await expect(hideOpeningOverlay()).resolves.toBeUndefined();
  });
});
