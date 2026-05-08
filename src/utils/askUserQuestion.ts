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

/** Compose the `tool_result` envelope Claude expects in response.
 *  `answers` carries the user's selections; `cancelled: true` signals
 *  the user dismissed the prompt with Esc. */
export function buildAskAnswerEnvelope(
  toolUseId: string,
  answers: AskAnswer[],
  opts: { cancelled?: boolean } = {},
): {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "tool_result"; tool_use_id: string; content: string }>;
  };
} {
  const payload = opts.cancelled
    ? { cancelled: true, answers }
    : { answers };
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify(payload),
        },
      ],
    },
  };
}
