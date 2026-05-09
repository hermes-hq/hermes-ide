/**
 * Helpers for surfacing agent-bridge spawn failures into the existing
 * `agent-stderr-{sessionId}` / `agent-exit-{sessionId}` event channels.
 *
 * Background: `spawnAgentSession` is called fire-and-forget from several
 * paths (initial create, workspace restore).  Until v1.1.1, a spawn that
 * rejected with "could not locate hermes-claude-bridge.mjs" or "node not
 * found" was caught with `console.error` only, so the user saw a session
 * marked Ready but no agent actually running — every Send call ended up
 * stuck on "awaiting claude" forever.
 *
 * By round-tripping the rejection through the same Tauri events the live
 * subprocess uses, the AgentSessionView's existing stderr / exit-notice
 * UI lights up automatically, no new render path required.
 */

import { emit } from "@tauri-apps/api/event";

export interface AgentSpawnFailurePayload {
  sessionId: string;
  error: unknown;
  /** Optional context label, e.g. "create", "restore", "convert". */
  context?: string;
}

/** Coerce any thrown value into a human-readable line. */
export function formatSpawnError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Emit a synthetic stderr line plus a synthetic exit event so the agent
 * view shows the failure inline (instead of leaving the user staring at
 * "awaiting claude" forever).
 *
 * The exit code is `-1` to distinguish a spawn failure from a real
 * subprocess exit; the AgentSessionView's classifyExit() falls through
 * to a generic "agent process exited" notice for unknown codes, which
 * is what we want here.
 *
 * Pure side-effects only — no return value — so callers can `void`
 * the call from sync paths without an unhandled-promise lint warning.
 */
export async function reportAgentSpawnFailure(
  payload: AgentSpawnFailurePayload,
  emitter: typeof emit = emit,
): Promise<void> {
  const { sessionId, error, context } = payload;
  const message = formatSpawnError(error);
  const prefix = context ? `[spawn:${context}] ` : "[spawn] ";
  const line = `${prefix}${message}\n`;
  // Emit both events; ignore individual emit failures (we don't want a
  // diagnostic emit failure to mask the original spawn error in logs).
  await Promise.all([
    emitter(`agent-stderr-${sessionId}`, line).catch(() => undefined),
    emitter(`agent-exit-${sessionId}`, { code: -1, signal: "spawn-failed" }).catch(
      () => undefined,
    ),
  ]);
}
