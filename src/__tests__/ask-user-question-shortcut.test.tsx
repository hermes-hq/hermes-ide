// @vitest-environment jsdom
/**
 * AskUserQuestion card — Cmd+Enter (mac) / Ctrl+Enter (win/linux) submits.
 *
 * Esc already cancels.  The send button is reachable by mouse and TAB, but
 * users in a flow state expect a keyboard send — and "naked" Enter is taken
 * by the "Other" textarea (for newlines).  Cmd/Ctrl+Enter is the standard
 * "send this form right now" shortcut across web UI (Slack, GitHub, Linear).
 *
 * Also asserts the send button surfaces the shortcut so it's discoverable.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AskUserQuestionCard } from "../components/AskUserQuestionCard";
import { isMac } from "../utils/platform";
import type { AskUserQuestionInput } from "../utils/askUserQuestion";

const SAMPLE_INPUT: AskUserQuestionInput = {
  questions: [
    {
      question: "Which approach?",
      header: "Approach",
      multiSelect: false,
      options: [
        { label: "Option A", description: "first" },
        { label: "Option B", description: "second" },
      ],
    },
  ],
};

afterEach(() => cleanup());

/** Fire the platform-appropriate "action mod + Enter" combo on `window`. */
function fireActionEnter(): void {
  fireEvent.keyDown(window, {
    key: "Enter",
    metaKey: isMac,
    ctrlKey: !isMac,
  });
}

describe("AskUserQuestionCard — keyboard submit", () => {
  it("Cmd/Ctrl+Enter submits when an option is selected", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );

    // Pick an option so the form is valid.
    fireEvent.click(screen.getByLabelText(/Option A/i));

    fireActionEnter();

    expect(onAllow).toHaveBeenCalledTimes(1);
    const updated = onAllow.mock.calls[0][0] as { answers: Record<string, string> };
    expect(updated.answers["Which approach?"]).toBe("Option A");
  });

  it("Cmd/Ctrl+Enter does NOT submit when nothing is selected (form invalid)", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );

    fireActionEnter();

    expect(onAllow).not.toHaveBeenCalled();
  });

  it("naked Enter (no modifier) does NOT submit — that key belongs to the textarea", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Option A/i));

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onAllow).not.toHaveBeenCalled();
  });

  it("the send button surfaces the keyboard shortcut for discoverability", () => {
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );

    const sendBtn = screen.getByRole("button", { name: /send/i });
    // Mac uses ⌘; Windows/Linux use Ctrl.
    if (isMac) {
      expect(sendBtn.textContent).toMatch(/⌘/);
    } else {
      expect(sendBtn.textContent).toMatch(/Ctrl/);
    }
  });
});
