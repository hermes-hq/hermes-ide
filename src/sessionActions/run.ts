// ─── Session actions: running a command ───────────────────────────────
//
// A terminal session's command goes through the backend
// (src-tauri/src/pty/session_command.rs), which types it with Enter only
// when the agent waits and the person's line is empty, and otherwise
// writes nothing and says why. Nothing here ever erases or edits what the
// person typed. A sent command is remembered (Recent) and counted
// (analytics: the action id only, never the command).

import { invoke } from "@tauri-apps/api/core";
import { trackFeatureUsed } from "../utils/analytics";
import type { SessionCommand } from "./catalog";
import { recordCommandSent, type CommandSend } from "./recent";

export type RunOutcome = "sent" | "busy" | "draft" | "no_agent" | "error";

/** The analytics name of a run: the action, or only what kind of command it was. */
export function analyticsFeature(cmd: SessionCommand): string {
  if (cmd.action) return `session_action.${cmd.action}`;
  return cmd.source === "builtin" ? "session_action.command" : "session_action.own_command";
}

/** Count and remember a command that was sent. */
export function noteSent(sessionId: string, agentId: string, cmd: SessionCommand, via: CommandSend["via"]): void {
  recordCommandSent(sessionId, agentId, cmd.text, via);
  trackFeatureUsed(analyticsFeature(cmd));
}

/**
 * Run a command in a terminal session (see the module comment).
 * `reportedWaiting`: the agent itself reported that it waits (its status is
 * exact or signalled, not guessed); the backend then need not wait for the
 * terminal's own guess (two seconds of quiet).
 */
export async function runInTerminal(sessionId: string, agentId: string, cmd: SessionCommand, via: CommandSend["via"], reportedWaiting = false): Promise<RunOutcome> {
  let outcome: RunOutcome;
  try {
    outcome = await invoke<RunOutcome>("run_session_command", { sessionId, line: cmd.text, reportedWaiting });
  } catch (err) {
    console.warn("[session-actions] command not run:", err);
    return "error";
  }
  if (outcome === "sent") noteSent(sessionId, agentId, cmd, via);
  return outcome;
}
