// @vitest-environment jsdom
/**
 * M1b — ExitPlanMode plan card.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1b) + §7.4.
 * Visual: §8.3.
 *
 * Approve / Reject only — no Modify (locked decision §0.4, TUI parity).
 *
 * The card responds via the `canUseTool` permission channel:
 *   - Approve  →  onAllow()                 (SDK runs the tool, mode flips)
 *   - Reject   →  onDeny(feedback || "")    (SDK ends turn with deny msg)
 *
 * The host wraps these into `_hermes_perm_response` envelopes — see
 * permissionRequest.ts.  No tool_result envelope is ever written by
 * the host for ExitPlanMode (that was the v1 silent-drop bug).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { isExitPlanModeToolUse } from "../utils/exitPlanMode";
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
  it("returns false for null/undefined", () => {
    expect(isExitPlanModeToolUse(null)).toBe(false);
    expect(isExitPlanModeToolUse(undefined)).toBe(false);
  });
});

describe("ExitPlanModeCard — render (ep-2, ep-3, ep-7)", () => {
  afterEach(() => cleanup());

  it("ep-2: renders the plan content (markdown text visible)", () => {
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText(/update foo/i)).toBeInTheDocument();
    expect(screen.getByText(/add a test/i)).toBeInTheDocument();
  });

  it("ep-3: shows Approve and Reject buttons; NO Modify button (TUI parity)", () => {
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /modify/i })).toBeNull();
  });

  it("ep-7: PLAN MODE banner shown when permissionMode=plan", () => {
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText(/plan mode/i)).toBeInTheDocument();
  });

  it("ep-7-b: no banner when permissionMode=default", () => {
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="default"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.queryByText(/plan mode/i)).toBeNull();
  });

  it("renders dialogId as data-dialog-id for tracing", () => {
    const { container } = render(
      <ExitPlanModeCard
        dialogId="perm-99"
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector('[data-dialog-id="perm-99"]')).not.toBeNull();
  });
});

describe("ExitPlanModeCard — approve / deny (ep-4, ep-5)", () => {
  afterEach(() => cleanup());

  it("ep-4: clicking Approve fires onAllow", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={onAllow}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("ep-5: clicking Reject opens feedback box; submitting fires onDeny(feedback)", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={onAllow}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    const textarea = screen.getByPlaceholderText(/why are you rejecting/i);
    fireEvent.change(textarea, { target: { value: "needs more research" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDeny).toHaveBeenCalledWith("needs more research");
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("ep-5-b: confirming reject without feedback fires onDeny('') (empty string allowed)", () => {
    const onDeny = vi.fn();
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDeny).toHaveBeenCalledWith("");
  });

  it("ep-5-c: rejecting trims whitespace from feedback", () => {
    const onDeny = vi.fn();
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.change(screen.getByPlaceholderText(/why are you rejecting/i), {
      target: { value: "   needs work   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDeny).toHaveBeenCalledWith("needs work");
  });

  it("cancel button on the reject form returns to the approve/reject screen", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(
      <ExitPlanModeCard
        input={SAMPLE_INPUT}
        permissionMode="plan"
        onAllow={onAllow}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    // Back to the approve/reject screen.
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(onAllow).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });
});

describe("ExitPlanModeCard — failure modes (ep-9, ep-10)", () => {
  afterEach(() => cleanup());

  it("ep-10: empty plan → renders 'no plan provided' message", () => {
    render(
      <ExitPlanModeCard
        input={{ plan: "" }}
        permissionMode="default"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText(/no plan provided/i)).toBeInTheDocument();
  });

  it("ep-9: HTML in markdown is escaped (no XSS)", () => {
    const { container } = render(
      <ExitPlanModeCard
        input={{ plan: "<script>alert(1)</script>raw text" }}
        permissionMode="default"
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("raw text");
  });
});
