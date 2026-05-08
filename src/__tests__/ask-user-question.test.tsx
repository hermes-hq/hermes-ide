// @vitest-environment jsdom
/**
 * M1a — AskUserQuestion native card.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1a) + §7.3.
 * Visual: §8.2.
 *
 * AskUserQuestion is the SDK's interactive-prompt tool.  Claude calls it
 * with a `questions` array; the host (Hermes) renders UI, captures the
 * user's selection, and answers the SDK's `canUseTool` callback with an
 * `updatedInput` that carries the user's `answers` (and optional
 * `annotations`).  The SDK then formats its own `tool_result` block.
 *
 * The card MUST NOT write a `tool_result` envelope itself — that was
 * the v1 bug: the SDK was waiting on canUseTool's promise, not on a
 * user message, so the answers were silently dropped.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  isAskUserQuestionToolUse,
  buildAskAnswersUpdatedInput,
  type AskUserQuestionInput,
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

  it("aq-1-d: returns false for null/undefined", () => {
    expect(isAskUserQuestionToolUse(null)).toBe(false);
    expect(isAskUserQuestionToolUse(undefined)).toBe(false);
  });
});

// ─── buildAskAnswersUpdatedInput — SDK Zod schema parity ────────────

describe("buildAskAnswersUpdatedInput (aq-6, aq-10) — SDK shape", () => {
  it("aq-6: single-select answer keyed by question text → option label", () => {
    const updated = buildAskAnswersUpdatedInput(SAMPLE_INPUT, [
      { question: "Which approach should we take?", selected: ["Option A"] },
    ]);
    expect(updated).toMatchObject({
      questions: SAMPLE_INPUT.questions,
      answers: {
        "Which approach should we take?": "Option A",
      },
    });
  });

  it("aq-6-b: multi-select answers comma-joined per the SDK contract", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          ...SAMPLE_INPUT.questions[0],
          multiSelect: true,
        },
      ],
    };
    const updated = buildAskAnswersUpdatedInput(input, [
      {
        question: "Which approach should we take?",
        selected: ["Option A", "Option B"],
      },
    ]);
    expect(updated.answers).toEqual({
      "Which approach should we take?": "Option A, Option B",
    });
  });

  it("aq-10-a: 'Other' answer surfaces typed notes text, not the literal 'Other'", () => {
    const updated = buildAskAnswersUpdatedInput(SAMPLE_INPUT, [
      {
        question: "Which approach should we take?",
        selected: ["Other"],
        notes: "use a different framework",
      },
    ]);
    expect(updated.answers).toEqual({
      "Which approach should we take?": "use a different framework",
    });
    // Whitespace-only notes are NOT used as the answer — fall back to "Other".
    expect((updated as { annotations?: unknown }).annotations).toBeUndefined();
  });

  it("aq-10-b: 'Other' with empty notes falls back to literal 'Other'", () => {
    const updated = buildAskAnswersUpdatedInput(SAMPLE_INPUT, [
      { question: "Q?", selected: ["Other"], notes: "   " },
    ]);
    expect((updated.answers as Record<string, string>)["Q?"]).toBe("Other");
  });

  it("aq-10-c: notes alongside a selection are emitted as annotations[q].notes", () => {
    const updated = buildAskAnswersUpdatedInput(SAMPLE_INPUT, [
      {
        question: "Q?",
        selected: ["Option A"],
        notes: "I'd also accept Option C",
      },
    ]);
    expect((updated as { annotations?: Record<string, { notes: string }> }).annotations).toEqual({
      "Q?": { notes: "I'd also accept Option C" },
    });
  });

  it("aq-14-b: multi-question input keys answers by each question text", () => {
    const input: AskUserQuestionInput = {
      questions: [
        { question: "first?", header: "Q1", multiSelect: false, options: [{ label: "A", description: "" }] },
        { question: "second?", header: "Q2", multiSelect: true, options: [
          { label: "X", description: "" },
          { label: "Y", description: "" },
        ] },
      ],
    };
    const updated = buildAskAnswersUpdatedInput(input, [
      { question: "first?", selected: ["A"] },
      { question: "second?", selected: ["X", "Y"] },
    ]);
    expect(updated.answers).toEqual({
      "first?": "A",
      "second?": "X, Y",
    });
  });

  it("aq-21-a: result has no `cancelled` key — denial goes through perm-response, not updatedInput", () => {
    const updated = buildAskAnswersUpdatedInput(SAMPLE_INPUT, [
      { question: "Q?", selected: ["Option A"] },
    ]);
    expect(updated).not.toHaveProperty("cancelled");
  });

  it("aq-21-b: original input keys are preserved (questions array passes through)", () => {
    const input: AskUserQuestionInput = {
      ...SAMPLE_INPUT,
      // @ts-expect-error allow extra keys on input pass-through
      metadata: { source: "remember" },
    };
    const updated = buildAskAnswersUpdatedInput(input, [
      { question: "Which approach should we take?", selected: ["Option A"] },
    ]);
    expect((updated as { metadata?: { source: string } }).metadata).toEqual({ source: "remember" });
  });
});

// ─── Component (RTL) ───────────────────────────────────────────────

describe("AskUserQuestionCard — render (aq-2, aq-3, aq-4, aq-5)", () => {
  afterEach(() => cleanup());

  it("aq-2: single-select renders as radios with auto Other option", () => {
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: /Option A/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Option B/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Other/i })).toBeInTheDocument();
  });

  it("aq-3: multi-select renders as checkboxes", () => {
    render(
      <AskUserQuestionCard
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Option A/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Option B/i })).toBeInTheDocument();
  });

  it("aq-4: 'Other' reveals textarea on selection; submit blocked when empty", () => {
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    const otherRadio = screen.getByRole("radio", { name: /Other/i });
    fireEvent.click(otherRadio);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: /send/i });
    expect(submit).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "my custom answer" } });
    expect(submit).not.toBeDisabled();
  });

  it("aq-5: option with preview renders preview pane when focused", () => {
    render(
      <AskUserQuestionCard
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
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /L1/i }));
    expect(screen.getByTestId("aq-preview-pane")).toHaveTextContent("A");
  });

  it("renders dialogId as data-dialog-id for tracing", () => {
    const { container } = render(
      <AskUserQuestionCard
        dialogId="perm-42"
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector('[data-dialog-id="perm-42"]')).not.toBeNull();
  });
});

// ─── Submit / cancel ─────────────────────────────────────────────────

describe("AskUserQuestionCard — submit invokes onAllow with SDK-shaped updatedInput", () => {
  afterEach(() => cleanup());

  it("aq-6: single-select calls onAllow with answers Record keyed by question text", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Option A/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onAllow).toHaveBeenCalledTimes(1);
    const updatedInput = onAllow.mock.calls[0][0] as Record<string, unknown>;
    expect(updatedInput.answers).toEqual({
      "Which approach should we take?": "Option A",
    });
    // Original input keys are preserved.
    expect(updatedInput.questions).toEqual(SAMPLE_INPUT.questions);
  });

  it("aq-6-b: multi-select submits comma-joined labels", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Option A/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    const updated = onAllow.mock.calls[0][0] as { answers: Record<string, string> };
    expect(updated.answers["Which approach should we take?"]).toBe("Option A, Option B");
  });

  it("aq-7: 'Other' with typed text submits the typed text as the answer", () => {
    const onAllow = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Other/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "freeform answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    const updated = onAllow.mock.calls[0][0] as { answers: Record<string, string> };
    expect(updated.answers["Which approach should we take?"]).toBe("freeform answer");
  });

  it("aq-9: Esc fires onDeny", () => {
    const onDeny = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("aq-9-b: cancel button fires onDeny", () => {
    const onDeny = vi.fn();
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("submit disabled when no selection made (validation guard)", () => {
    render(
      <AskUserQuestionCard
        input={SAMPLE_INPUT}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

// ─── §7.3 failure modes ────────────────────────────────────────────

describe("AskUserQuestionCard — failure modes (aq-13..aq-21)", () => {
  afterEach(() => cleanup());

  it("aq-13: empty questions array → onDeny auto-fires (degenerate input)", () => {
    const onDeny = vi.fn();
    render(
      <AskUserQuestionCard
        input={{ questions: [] }}
        onAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    expect(onDeny).toHaveBeenCalled();
  });

  it("aq-14: 3-question input renders all three (legend + question text per question)", () => {
    render(
      <AskUserQuestionCard
        input={{
          questions: [
            { question: "first?", header: "Q1", multiSelect: false, options: [{ label: "A", description: "" }] },
            { question: "second?", header: "Q2", multiSelect: false, options: [{ label: "A", description: "" }] },
            { question: "third?", header: "Q3", multiSelect: false, options: [{ label: "A", description: "" }] },
          ],
        }}
        onAllow={() => {}}
        onDeny={() => {}}
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
        input={{
          questions: [
            {
              ...SAMPLE_INPUT.questions[0],
              multiSelect: true,
            },
          ],
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("aq-21: full multi-question round-trip produces SDK-canonical Record<string,string>", () => {
    const input: AskUserQuestionInput = {
      questions: [
        { question: "a?", header: "A", multiSelect: false, options: [{ label: "x", description: "" }] },
        { question: "b?", header: "B", multiSelect: true, options: [
          { label: "y", description: "" },
          { label: "z", description: "" },
        ] },
      ],
    };
    const updated = buildAskAnswersUpdatedInput(input, [
      { question: "a?", selected: ["x"] },
      { question: "b?", selected: ["y", "z"] },
    ]);
    expect(updated.answers).toEqual({
      "a?": "x",
      "b?": "y, z",
    });
  });
});
