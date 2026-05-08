// @vitest-environment jsdom
/**
 * SessionCreatorOpeningOverlay — the visible "Opening new session…"
 * surface that appears the moment Cmd+N / new-session button fires
 * (M9 + M11).
 *
 * Pin the class names + accessibility role so a stylesheet rename or
 * accidental refactor doesn't silently make the loader invisible
 * again.  The "no loader at all" report we just fixed was exactly
 * that: stylesheet was correct in source, but unloaded in the bundle
 * because it sat inside SessionCreator.css which only loaded with the
 * modal — i.e., never in time.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SessionCreatorOpeningOverlay } from "../components/SessionCreatorOpeningOverlay";

describe("SessionCreatorOpeningOverlay", () => {
  afterEach(() => cleanup());

  it("renders an aria-live status region", () => {
    render(<SessionCreatorOpeningOverlay />);
    const node = screen.getByRole("status");
    expect(node).toBeInTheDocument();
    expect(node.getAttribute("aria-live")).toBe("polite");
  });

  it("renders the brass-uppercase text label", () => {
    render(<SessionCreatorOpeningOverlay />);
    expect(screen.getByText(/opening new session/i)).toBeInTheDocument();
  });

  it("uses the dedicated overlay class so its self-imported CSS loads", () => {
    render(<SessionCreatorOpeningOverlay />);
    const node = screen.getByTestId("session-creator-opening-overlay");
    expect(node.classList.contains("session-creator-opening-overlay")).toBe(true);
  });
});
