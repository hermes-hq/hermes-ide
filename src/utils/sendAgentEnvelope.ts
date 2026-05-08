/**
 * Resilient envelope sender for interactive tool responses
 * (AskUserQuestion answers, ExitPlanMode decisions, canUseTool replies).
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §M10.
 *
 * Claude's `--print` subprocess exits after every turn — the bridge
 * goes with it.  Between turns the Rust side has no live AgentChild
 * for the session, so a raw `send_agent_input` IPC returns
 * `"Agent session '<sid>' not found"`.  The composer's
 * `submitAgentMessage` already wraps its sends with a respawn-then-
 * retry — interactive tool handlers must do the same, or the user's
 * answer is silently dropped (the production "submit does nothing"
 * symptom in plan mode).
 *
 * Pure helper so the retry contract is testable without rendering.
 */

export interface SendAgentEnvelopeDeps {
  send: (sessionId: string, envelope: unknown) => Promise<void>;
  /** Bring the bridge back up via plain `--resume` (no fork).  Returns
   *  `true` if the new spawn succeeded, `false` otherwise.  Mirrors
   *  `respawnAgent(sid, {})` from SessionContext. */
  respawn: (sessionId: string) => Promise<boolean>;
}

export async function sendAgentEnvelopeWithRevive(
  sessionId: string,
  envelope: unknown,
  deps: SendAgentEnvelopeDeps,
): Promise<void> {
  try {
    await deps.send(sessionId, envelope);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found/i.test(message)) {
      throw err;
    }
    const ok = await deps.respawn(sessionId);
    if (!ok) {
      throw new Error("Could not revive Claude subprocess to deliver tool response");
    }
    await deps.send(sessionId, envelope);
  }
}
