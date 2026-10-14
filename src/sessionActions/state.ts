// ─── Session actions: when a command may run, and the one state chip ──
//
// Derived only from what the session already knows: its status (the
// agent's own reports, F10), its event snapshot (exit, usage limit, a
// refused launch) and its startup state. Nothing is guessed here.

import type { AgentStatusKind } from "../agent/contract/status";
import { commandForAction, type SessionCommand } from "./catalog";

/**
 * Statuses in which the agent is at its prompt, waiting for the person's
 * next message: a command may be typed. Not while it works, starts, or
 * asks a question or a permission (the line would answer that instead).
 */
const READY: ReadonlySet<AgentStatusKind> = new Set<AgentStatusKind>(["idle", "done_unread", "error", "limited", "check_failed"]);

export function takesCommands(status: AgentStatusKind): boolean {
  return READY.has(status);
}

/** The bar shows at most one of these, in this order of importance. */
export type StateChip =
  /** The CLI refused the launch because the account is signed out. */
  | { kind: "sign_in" }
  /** The agent exited (or crashed): start it again on its conversation. */
  | { kind: "resume" }
  /** A usage limit stopped the agent: the agent's usage command. */
  | { kind: "usage"; command: SessionCommand };

export interface StateInputs {
  agentId: string | null;
  surface: "terminal" | "agent";
  status: AgentStatusKind;
  /** The last refused launch's reason, if one is standing. */
  rejection: string | null;
  /** The agent's last limit event said it is limited. */
  limited: boolean;
  /** The agent was started by the launch helper and its launch has ended (it can be started again). */
  helperEnded: boolean;
  /** The agent's CLI has a sign-in Hermes can run. */
  canSignIn: boolean;
}

export function stateChipFor(i: StateInputs): StateChip | null {
  if (i.surface === "terminal" && i.rejection === "signed_out" && i.canSignIn) return { kind: "sign_in" };
  if (i.surface === "terminal" && i.status === "exited" && i.helperEnded && i.rejection === null) return { kind: "resume" };
  if (i.limited || i.status === "limited") {
    const command = commandForAction(i.agentId, "usage");
    if (command && !command.destructive) return { kind: "usage", command };
  }
  return null;
}
