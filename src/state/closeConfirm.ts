import type { SessionMode } from "../types/session";

/** What the close decision needs to know about a session. */
export interface CloseCandidate {
  mode?: SessionMode;
  /** The agent the session was started for, if any. */
  ai_provider?: string | null;
  /** An agent seen running in the terminal. */
  detected_agent?: unknown;
}

/**
 * Whether closing a session asks "Close session?" first. A plain shell (no
 * agent started in it or seen in it) sitting at its prompt has nothing
 * running to stop, so it closes at once. A session started for an agent
 * asks, even while its agent is still starting; so does an Agent view
 * session, a shell running a program, or one whose check fails.
 */
export async function closeNeedsConfirm(
  session: CloseCandidate | undefined,
  shellAtPrompt: () => Promise<boolean>,
): Promise<boolean> {
  if (!session || session.mode === "agent" || session.ai_provider || session.detected_agent) return true;
  try {
    return !(await shellAtPrompt());
  } catch {
    return true;
  }
}
