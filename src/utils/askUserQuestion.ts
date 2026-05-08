/**
 * Pure helpers for the AskUserQuestion interactive tool.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1a) and §7.3.
 *
 * Claude calls AskUserQuestion when it wants the user to pick from a
 * structured set of options.  The host (Hermes) renders a card, captures
 * the answers, and writes a `tool_result` envelope back on stdin so
 * Claude can continue the turn.  Without us writing back, the
 * conversation stalls indefinitely.
 */

import type { ToolUseBlockData } from "../agent/types";

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
}

export interface AskAnswer {
  question: string;
  selected: string[];
  notes?: string;
}

/** Returns true iff the block is an AskUserQuestion tool_use. */
export function isAskUserQuestionToolUse(
  block: { type?: string; name?: string } | null | undefined,
): block is ToolUseBlockData & { name: "AskUserQuestion"; input: AskUserQuestionInput } {
  return !!block && block.type === "tool_use" && block.name === "AskUserQuestion";
}

/** Project the user's answers into the SDK-shaped `updatedInput` record
 *  the AskUserQuestion tool expects to receive via `canUseTool`.
 *
 *  Confirmed against the bundled Claude Code binary
 *  (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` strings):
 *
 *    answers     :  Record<questionText, answerString>
 *                   - single-select  → the chosen option label
 *                   - multi-select   → comma-joined option labels
 *                   - "Other"        → the freeform notes text
 *    annotations :  Record<questionText, { notes?: string }>
 *                   - present when the user supplied freeform notes
 *                     (e.g. typed text in the auto "Other" textarea)
 *
 *  The SDK then formats its own `tool_result` block via
 *  `mapToolResultToToolResultBlockParam`; we never write a `tool_result`
 *  envelope ourselves for AskUserQuestion.  Doing so was the cause of
 *  the silent "submit does nothing" bug — the SDK was waiting on
 *  canUseTool's promise, not on a user message. */
export function buildAskAnswersUpdatedInput(
  input: AskUserQuestionInput,
  answers: AskAnswer[],
): Record<string, unknown> {
  const answersByQuestion: Record<string, string> = {};
  const annotations: Record<string, { notes?: string }> = {};

  for (const ans of answers) {
    const isOther = ans.selected.length === 1 && ans.selected[0] === "Other";
    if (isOther) {
      // "Other" is the auto-injected freeform option — the user's
      // actual answer lives in `notes`.  Surface it as the answer
      // string so Claude sees the typed text, not the literal word
      // "Other".
      answersByQuestion[ans.question] = ans.notes?.trim() || "Other";
    } else {
      answersByQuestion[ans.question] = ans.selected.join(", ");
    }
    if (ans.notes && ans.notes.trim() !== "" && !isOther) {
      annotations[ans.question] = { notes: ans.notes.trim() };
    }
  }

  const updated: Record<string, unknown> = {
    ...input,
    answers: answersByQuestion,
  };
  if (Object.keys(annotations).length > 0) {
    updated.annotations = annotations;
  }
  return updated;
}
