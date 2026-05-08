// @vitest-environment jsdom
/**
 * M1b — ExitPlanMode plan card.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1b) + §7.4.
 * Visual: §8.3.
 *
 * Approve / Reject only — no Modify (locked decision §0.4, TUI parity).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  isExitPlanModeToolUse,
  buildExitPlanResult,
} from "../utils/exitPlanMode";
import { ExitPlanModeCard } from "../components/ExitPlanModeCard";

const SAMPLE_INPUT = {
  plan: "## Plan\n\n1. Update foo\n2. Add a test\n3. Run preflight",
};

describe("isExitPlanModeToolUse (ep-1)", () => {
  it("recognises name=ExitPlanMode tool_use", () => {
    expect(isExitPlanModeToolUse({ type: "tool_use", id: "tu", name: "ExitPlanMode", input: SAMPLE_INPUT })).toBe(true);
  });
  it("returns false for other tool names", () => {
    expect(isExitPlanModeToolUse({ type: "tool_use", id: "tu", name: "Bash", input: {} })).toBe(false);
  });
});

describe("buildExitPlanResult (ep-4, ep-5)", () => {
  it("ep-4: approve → tool_result {accept: true}", () => {
    const env = buildExitPlanResult("tu_1", { accept: true });
    const parsed = JSON.parse((env.message.content[0] as { content: string }).content);
    expect(parsed).toEqual({ accept: true });
  });
  it("ep-5: reject with feedback", () => {
    const env = buildExitPlanResult("tu_1", { accept: false, feedback: "rethink" });
    const parsed = JSON.parse((env.message.content[0] as { content: string }).content);
    expect(parsed).toEqual({ accept: false, feedback: "rethink" });
  });
  it("ep-11: reject without feedback (empty allowed)", () => {
    const env = buildExitPlanResult("tu_1", { accept: false });
    const parsed = JSON.parse((env.message.content[0] as { content: string }).content);
    expect(parsed).toEqual({ accept: false });
  });
});

describe("ExitPlanModeCard — render (ep-2, ep-3, ep-7)", () => {
  afterEach(() => cleanup());

  it("ep-2: renders the plan content (markdown text visible)", () => {
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/update foo/i)).toBeInTheDocument();
    expect(screen.getByText(/add a test/i)).toBeInTheDocument();
  });

  it("ep-3: shows Approve and Reject buttons; NO Modify button (TUI parity)", () => {
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /modify/i })).toBeNull();
  });

  it("ep-7: PLAN MODE banner shown when permissionMode=plan", () => {
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/plan mode/i)).toBeInTheDocument();
  });

  it("ep-7-b: no banner when permissionMode=default", () => {
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="default"
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByText(/plan mode/i)).toBeNull();
  });
});

describe("ExitPlanModeCard — submit (ep-4, ep-5)", () => {
  afterEach(() => cleanup());

  it("ep-4: clicking Approve fires onSubmit({accept: true})", () => {
    const onSubmit = vi.fn();
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onSubmit).toHaveBeenCalledWith({ accept: true });
  });

  it("ep-5: clicking Reject opens feedback box; submitting fires onSubmit({accept: false, feedback})", () => {
    const onSubmit = vi.fn();
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    const textarea = screen.getByPlaceholderText(/why are you rejecting/i);
    fireEvent.change(textarea, { target: { value: "needs more research" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onSubmit).toHaveBeenCalledWith({ accept: false, feedback: "needs more research" });
  });

  it("ep-5-b: confirming reject without feedback also fires (empty allowed per ep-11)", () => {
    const onSubmit = vi.fn();
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onSubmit).toHaveBeenCalledWith({ accept: false });
  });
});

describe("ExitPlanModeCard — failure modes (ep-9, ep-10)", () => {
  afterEach(() => cleanup());

  it("ep-10: empty plan → renders 'no plan provided' message", () => {
    render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={{ plan: "" }}
        permissionMode="default"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/no plan provided/i)).toBeInTheDocument();
  });

  it("ep-9: HTML in markdown is escaped (no XSS)", () => {
    const { container } = render(
      <ExitPlanModeCard
        toolUseId="tu_1"
        input={{ plan: "<script>alert(1)</script>raw text" }}
        permissionMode="default"
        onSubmit={() => {}}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("raw text");
  });
});
