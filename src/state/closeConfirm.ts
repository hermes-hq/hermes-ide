import type { SessionMode } from "../types/session";

/**
 * Whether closing a session asks "Close session?" first. A terminal whose
 * shell sits at its prompt has nothing running to stop, so it closes at once.
 * An Agent view session, or a terminal running a program (an agent
 * included), asks. When the check fails, it asks.
 */
export async function closeNeedsConfirm(
  mode: SessionMode | undefined,
  shellAtPrompt: () => Promise<boolean>,
): Promise<boolean> {
  if (mode === "agent") return true;
  try {
    return !(await shellAtPrompt());
  } catch {
    return true;
  }
}
