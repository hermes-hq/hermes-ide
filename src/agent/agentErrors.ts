/**
 * Typed errors for the Agent view.
 *
 * One pure function turns what the view already knows about a session (the
 * agent's exit, its stderr, the last result event, unreadable output) into
 * one of five kinds, each with a plain message and the action that can fix
 * it:
 *
 *   spawn_failed  the agent process could not be started        -> Retry
 *   signed_out    the agent says it is not signed in             -> Sign in
 *   exited        the agent process stopped unexpectedly         -> Retry
 *   busy          the session already has a running process      -> (none)
 *   protocol      the agent printed output Hermes cannot read    -> Retry
 *
 * Nothing here is Claude-specific except the sign-in phrases the agent
 * prints; the agent's display name is a parameter.
 */
import type { AgentErrorKind } from "../api/agent";
import type { AgentViewSnapshot } from "./agentSessionStore";

export type AgentErrorAction = "retry" | "sign-in";

export interface AgentErrorView {
  kind: AgentErrorKind;
  /** Short heading, e.g. "Claude is signed out". */
  title: string;
  /** One or two sentences: what happened and what to do. */
  message: string;
  /** Raw text for the curious (stderr tail, backend message), or null. */
  detail: string | null;
  action: AgentErrorAction | null;
}

/** What the agent prints when it has no valid login. Kept narrow on purpose:
 *  a false "signed out" would send people to sign in for nothing. */
const SIGNED_OUT_PATTERNS: RegExp[] = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /oauth token (?:has )?expired/i,
  /\bauthentication_failed\b/i,
  /\bsigned out\b/i,
];

export function looksSignedOut(text: string | null | undefined): boolean {
  if (!text) return false;
  return SIGNED_OUT_PATTERNS.some((re) => re.test(text));
}

/** Last few non-empty lines of stderr, for the Details section. */
function tail(text: string, lines = 12): string | null {
  const kept = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (kept.length === 0) return null;
  return kept.slice(-lines).join("\n");
}

function exitSuffix(exit: { code: number | null; signal: string | null }): string {
  if (exit.signal) return ` (signal ${exit.signal})`;
  if (exit.code !== null) return ` (exit code ${exit.code})`;
  return "";
}

export type AgentErrorInput = Pick<AgentViewSnapshot, "state" | "stderr" | "exit" | "protocolError">;

/**
 * The error to show for a session, or null when there is nothing wrong.
 *
 * Order matters: a failed or refused start comes from the latest restart
 * attempt, so it describes the session now; a sign-in problem usually also
 * ends the process, and the sign-in hint is the useful one; unreadable output
 * explains the exit that follows it.
 */
export function classifyAgentError(input: AgentErrorInput, agentName = "Claude"): AgentErrorView | null {
  const { state, stderr, exit, protocolError } = input;
  const resultError =
    state.resultEvent && state.resultEvent.is_error
      ? state.lastError ?? (typeof state.resultEvent.result === "string" ? state.resultEvent.result : null)
      : null;

  if (exit?.kind === "busy") {
    return {
      kind: "busy",
      title: `${agentName} is already running`,
      message: `${agentName} is already running in this session. Wait for it to finish, then send your message again.`,
      detail: tail(stderr),
      action: null,
    };
  }

  if (exit?.kind === "spawn_failed" || exit?.signal === "spawn-failed") {
    return {
      kind: "spawn_failed",
      title: `Couldn't start ${agentName}`,
      message: `Hermes couldn't start ${agentName}. Check the details, fix what they point to, then retry.`,
      detail: tail(stderr),
      action: "retry",
    };
  }

  if (looksSignedOut(resultError) || (exit && looksSignedOut(stderr))) {
    return {
      kind: "signed_out",
      title: `${agentName} is signed out`,
      message: `Sign in to ${agentName} in the terminal that opens, then send your message again.`,
      detail: resultError ?? tail(stderr),
      action: "sign-in",
    };
  }

  if (protocolError) {
    return {
      kind: "protocol",
      title: `${agentName} sent output Hermes couldn't read`,
      message: `${agentName} printed something that isn't part of its normal output, so this turn may be incomplete. Retry to restart ${agentName}; the conversation is kept.`,
      detail: protocolError,
      action: "retry",
    };
  }

  // Same rule as the old exit notice: a non-zero code or a signal is a
  // crash; a clean exit only matters before any conversation happened.
  if (exit && (exit.signal || (exit.code !== null && exit.code !== 0) || state.messages.length === 0)) {
    return {
      kind: "exited",
      title: `${agentName} stopped`,
      message: `${agentName} stopped unexpectedly${exitSuffix(exit)}. Retry to restart it; the conversation is kept.`,
      detail: tail(stderr),
      action: "retry",
    };
  }

  return null;
}
