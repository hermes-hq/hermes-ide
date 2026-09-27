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
 *   busy          the session already has a running process      -> Dismiss
 *   protocol      the agent printed output Hermes cannot read    -> Retry
 *
 * Nothing here is Claude-specific except the sign-in phrases the agent
 * prints; the agent's display name is a parameter (see agentDisplayName) and
 * every sentence goes through the i18n registry ("agentError.*" keys).
 */
import type { AgentErrorKind } from "../api/agent";
import { translate } from "../i18n/registry";
import { AI_PROVIDERS } from "../utils/aiProviders";
import type { AgentViewSnapshot } from "./agentSessionStore";

export type AgentErrorAction = "retry" | "sign-in" | "dismiss";

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The name to show for a session's agent: the provider's label ("Claude",
 *  "Codex", ...), the raw provider id when it is not a known one, and
 *  "Claude" when the session has no provider yet (Agent view's default). */
export function agentDisplayName(providerId: string | null | undefined): string {
  if (!providerId) return "Claude";
  return AI_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
}

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

/** Only the last lines of stderr decide "signed out" for an exit: stderr is
 *  kept for the whole process, so an older warning that happens to mention
 *  signing in must not turn an unrelated crash into a Sign in panel. */
const SIGNED_OUT_TAIL_LINES = 5;

/** Last few non-empty lines of stderr, for the Details section. */
function tail(text: string, lines = 12): string | null {
  const kept = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (kept.length === 0) return null;
  return kept.slice(-lines).join("\n");
}

function exitStatus(exit: { code: number | null; signal: string | null }, t: Translate): string | null {
  if (exit.signal) return t("agentError.exitSignal", { signal: exit.signal });
  if (exit.code !== null) return t("agentError.exitCode", { code: exit.code });
  return null;
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
export function classifyAgentError(
  input: AgentErrorInput,
  agentName = "Claude",
  t: Translate = translate,
): AgentErrorView | null {
  const { state, stderr, exit, protocolError } = input;
  const agent = { agent: agentName };
  const resultError =
    state.resultEvent && state.resultEvent.is_error
      ? state.lastError ?? (typeof state.resultEvent.result === "string" ? state.resultEvent.result : null)
      : null;

  if (exit?.kind === "busy") {
    return {
      kind: "busy",
      title: t("agentError.busy.title", agent),
      message: t("agentError.busy.message", agent),
      detail: tail(stderr),
      action: "dismiss",
    };
  }

  if (exit?.kind === "spawn_failed" || exit?.signal === "spawn-failed") {
    return {
      kind: "spawn_failed",
      title: t("agentError.spawnFailed.title", agent),
      message: t("agentError.spawnFailed.message", agent),
      detail: tail(stderr),
      action: "retry",
    };
  }

  if (looksSignedOut(resultError) || (exit && looksSignedOut(tail(stderr, SIGNED_OUT_TAIL_LINES)))) {
    return {
      kind: "signed_out",
      title: t("agentError.signedOut.title", agent),
      message: t("agentError.signedOut.message", agent),
      detail: resultError ?? tail(stderr),
      action: "sign-in",
    };
  }

  if (protocolError) {
    return {
      kind: "protocol",
      title: t("agentError.protocol.title", agent),
      message: t("agentError.protocol.message", agent),
      detail: protocolError,
      action: "retry",
    };
  }

  // Same rule as the old exit notice: a non-zero code or a signal is a
  // crash; a clean exit only matters before any conversation happened.
  if (exit && (exit.signal || (exit.code !== null && exit.code !== 0) || state.messages.length === 0)) {
    const status = exitStatus(exit, t);
    return {
      kind: "exited",
      title: t("agentError.exited.title", agent),
      message: status
        ? t("agentError.exited.messageWithStatus", { agent: agentName, status })
        : t("agentError.exited.message", agent),
      detail: tail(stderr),
      action: "retry",
    };
  }

  return null;
}
