// @vitest-environment jsdom
/**
 * M1d — Plan-mode banner.  Spec §2 (M1d).  Visual §8.5.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PlanModeBanner } from "../components/PlanModeBanner";

describe("PlanModeBanner", () => {
  afterEach(() => cleanup());

  it("pb-1: renders iff permissionMode === 'plan'", () => {
    const { container } = render(<PlanModeBanner permissionMode="plan" />);
    expect(container.querySelector(".plan-mode-banner")).toBeInTheDocument();
  });

  it("pb-1-b: returns null for non-plan modes", () => {
    const { container } = render(<PlanModeBanner permissionMode="default" />);
    expect(container.querySelector(".plan-mode-banner")).toBeNull();
  });

  it("pb-2: text includes 'PLAN MODE' and the no-edits-execute warning", () => {
    render(<PlanModeBanner permissionMode="plan" />);
    expect(screen.getByText(/plan mode/i)).toBeInTheDocument();
    expect(screen.getByText(/no edits will execute/i)).toBeInTheDocument();
  });

  it("pb-3: has clickable role for opening permission picker (when handler given)", () => {
    let clicked = false;
    render(<PlanModeBanner permissionMode="plan" onClick={() => (clicked = true)} />);
    const btn = screen.getByRole("button");
    btn.click();
    expect(clicked).toBe(true);
  });
});
