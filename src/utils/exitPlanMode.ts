/**
 * ExitPlanMode helpers.  Spec: §2 (M1b), §7.4.
 *
 * ExitPlanMode is the SDK tool Claude calls at the end of plan-mode
 * deliberation.  Its `input.plan` is a markdown summary of what Claude
 * will do if the user approves.  We render it as a card with Approve /
 * Reject buttons; the response goes back through `canUseTool` as
 * `{behavior: "allow"}` (Claude proceeds and the SDK flips out of plan
 * mode) or `{behavior: "deny", message: <feedback>}` (Claude reads the
 * feedback as a deny message and revises).
 *
 * No envelope builder lives here — the perm response is the protocol.
 */

import type { ToolUseBlockData } from "../agent/types";

export interface ExitPlanModeInput {
  plan: string;
}

export function isExitPlanModeToolUse(
  block: { type?: string; name?: string } | null | undefined,
): block is ToolUseBlockData & { name: "ExitPlanMode"; input: ExitPlanModeInput } {
  return !!block && block.type === "tool_use" && block.name === "ExitPlanMode";
}
