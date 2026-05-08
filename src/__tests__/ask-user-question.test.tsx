// @vitest-environment jsdom
/**
 * M1a — AskUserQuestion native modal.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1a) + §7.3.
 * Visual: §8.2.
 *
 * AskUserQuestion is the SDK's interactive-prompt tool.  Claude calls it
 * with a `questions` array; the host (Hermes) renders UI, captures the
 * user's selection, and writes back a `tool_result` envelope on stdin.
 * Without our card, the question shows as a plain tool block and the
 * conversation stalls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  isAskUserQuestionToolUse,
  buildAskAnswerEnvelope,
  type AskUserQuestionInput,
  type AskAnswer,
} from "../utils/askUserQuestion";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard";

const SAMPLE_INPUT: AskUserQuestionInput = {
  questions: [
    {
      question: "Which approach should we take?",
      header: "Approach",
      multiSelect: false,
      options: [
        { label: "Option A", description: "first option" },
        { label: "Option B", description: "second option" },
      ],
    },
  ],
};

// ─── Pure helpers ───────────────────────────────────────────────────

describe("isAskUserQuestionToolUse", () => {
  it("aq-1: recognises name=AskUserQuestion tool_use", () => {
    expect(
      isAskUserQuestionToolUse({
        type: "tool_use",
        id: "tu_1",
        name: "AskUserQuestion",
        input: SAMPLE_INPUT,
      }),
    ).toBe(true);
  });

  it("aq-1-b: returns false for other tool_use names", () => {
    expect(
      isAskUserQuestionToolUse({
        type: "tool_use",
        id: "tu_1",
        name: "Bash",
        input: {},
      }),
    ).toBe(false);
  });

  it("aq-1-c: returns false for non-tool_use blocks", () => {
    expect(isAskUserQuestionToolUse({ type: "text", text: "hi" } as never)).toBe(false);
  });
});

describe("buildAskAnswerEnvelope (aq-6, aq-10)", () => {
  it("aq-6: composes tool_result envelope with correct shape", () => {
    const env = buildAskAnswerEnvelope("tu_1", [
      { question: "Q1", selected: ["Option A"] },
    ]);
    expect(env).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: expect.any(String),
          },
        ],
      },
    });
    // The content is the JSON-stringified answers — Claude reads it back.
    const parsed = JSON.parse(
      (env.message.content[0] as { content: string }).content,
    );
    expect(parsed.answers[0].selected).toEqual(["Option A"]);
  });

  it("aq-10: serializes answers as [{question, selected, notes?}]", () => {
    const env = buildAskAnswerEnvelope("tu_1", [
      { question: "Q1", selected: ["A"], notes: "freeform" },
    ]);
    const parsed = JSON.parse(
      (env.message.content[0] as { content: string }).content,
    );
    expect(parsed.answers).toEqual([
      { question: "Q1", selected: ["A"], notes: "freeform" },
    ]);
  });

  it("aq-9: cancel envelope sets cancelled flag", () => {
    const env = buildAskAnswerEnvelope("tu_1", [], { cancelled: true });
    const parsed = JSON.parse(
      (env.message.content[0] as { content: string }).content,
    );
    expect(parsed.cancelled).toBe(true);
  });
});

// ─── Component (RTL) ───────────────────────────────────────────────

describe("AskUserQuestionCard — render (aq-2, aq-3, aq-4, aq-5)", () => {
  afterEach(() => cleanup());

  it("aq-2: single-select renders as radios with auto Other option", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: /Option A/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Option B/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Other/i })).toBeInTheDocument();
  });

  it("aq-3: multi-select renders as checkboxes", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Option A/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Option B/i })).toBeInTheDocument();
  });

  it("aq-4: 'Other' reveals textarea on selection; submit blocked when empty", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const otherRadio = screen.getByRole("radio", { name: /Other/i });
    fireEvent.click(otherRadio);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();

    // Submit should be disabled until textarea has content.
    const submit = screen.getByRole("button", { name: /send/i });
    expect(submit).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "my custom answer" } });
    expect(submit).not.toBeDisabled();
  });

  it("aq-5: option with preview renders preview pane when focused", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{
          questions: [
            {
              question: "Pick a layout",
              header: "Layout",
              multiSelect: false,
              options: [
                { label: "L1", description: "side-by-side", preview: "│ A │ B │" },
                { label: "L2", description: "stacked", preview: "── A ──\n── B ──" },
              ],
            },
          ],
        }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /L1/i }));
    expect(screen.getByTestId("aq-preview-pane")).toHaveTextContent("A");
  });
});

describe("AskUserQuestionCard — submit (aq-6, aq-7, aq-9)", () => {
  afterEach(() => cleanup());

  it("aq-6: submit fires onSubmit with composed answers (single-select)", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Option A/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { question: "Which approach should we take?", selected: ["Option A"] },
    ]);
  });

  it("aq-6-b: submit collects multi-select answers", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Option A/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    const answers = onSubmit.mock.calls[0][0] as AskAnswer[];
    expect(answers[0].selected).toEqual(["Option A", "Option B"]);
  });

  it("aq-9: Esc fires onCancel", () => {
    const onCancel = vi.fn();
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("submit disabled when no selection made (validation guard)", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={SAMPLE_INPUT}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

// ─── §7.3 failure modes ────────────────────────────────────────────

describe("AskUserQuestionCard — failure modes (aq-13..aq-21)", () => {
  afterEach(() => cleanup());

  it("aq-13: empty questions array → onCancel auto-fires (degenerate input)", () => {
    const onCancel = vi.fn();
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{ questions: [] }}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    expect(onCancel).toHaveBeenCalled();
  });

  it("aq-14: 3-question input renders all three (legend + question text per question)", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{
          questions: [
            { question: "first?", header: "Q1", multiSelect: false, options: [{ label: "A", description: "" }] },
            { question: "second?", header: "Q2", multiSelect: false, options: [{ label: "A", description: "" }] },
            { question: "third?", header: "Q3", multiSelect: false, options: [{ label: "A", description: "" }] },
          ],
        }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Q1")).toBeInTheDocument();
    expect(screen.getByText("Q2")).toBeInTheDocument();
    expect(screen.getByText("Q3")).toBeInTheDocument();
    expect(screen.getByText("first?")).toBeInTheDocument();
    expect(screen.getByText("second?")).toBeInTheDocument();
    expect(screen.getByText("third?")).toBeInTheDocument();
  });

  it("aq-17: empty multi-select submit blocked (no selection, no Other content)", () => {
    render(
      <AskUserQuestionCard
        toolUseId="tu_1"
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("aq-21: tool_result envelope round-trips (snapshot-pinned shape)", () => {
    const env = buildAskAnswerEnvelope("tu_42", [
      { question: "Q1", selected: ["A"] },
      { question: "Q2", selected: ["X", "Y"], notes: "freeform" },
    ]);
    expect(env).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_42",
            content: JSON.stringify({
              answers: [
                { question: "Q1", selected: ["A"] },
                { question: "Q2", selected: ["X", "Y"], notes: "freeform" },
              ],
            }),
          },
        ],
      },
    });
  });
});
