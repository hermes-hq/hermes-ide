/**
 * ExitPlanMode helpers.  Spec: §2 (M1b), §7.4.
 *
 * ExitPlanMode is the SDK tool Claude calls at the end of plan-mode
 * deliberation.  Its `input.plan` is a markdown summary of what Claude
 * will do if the user approves.  We render it as a card with Approve /
 * Reject buttons and write the user's decision back as a `tool_result`.
 */

import type { ToolUseBlockData } from "../agent/types";

export interface ExitPlanModeInput {
  plan: string;
}

export interface ExitPlanModeDecision {
  accept: boolean;
  feedback?: string;
}

export function isExitPlanModeToolUse(
  block: { type?: string; name?: string } | null | undefined,
): block is ToolUseBlockData & { name: "ExitPlanMode"; input: ExitPlanModeInput } {
  return !!block && block.type === "tool_use" && block.name === "ExitPlanMode";
}

export function buildExitPlanResult(
  toolUseId: string,
  decision: ExitPlanModeDecision,
): {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "tool_result"; tool_use_id: string; content: string }>;
  };
} {
  const payload: ExitPlanModeDecision = decision.feedback
    ? decision
    : { accept: decision.accept };
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
