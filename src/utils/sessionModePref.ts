// ─── Per-agent session mode preference ──────────────────────────────
//
// Terminal first (ADR 003): every new session runs the agent in its own
// terminal interface. Some agents also have an optional Agent view (a
// Hermes-rendered structured view). The session creator remembers, per
// agent, whether the user last chose that view, and preselects it next time.
//
// Stored in the `session_mode_by_provider` setting as a JSON map of
// providerId -> "terminal" | "agent". It only preselects the choice in the
// creator; it never changes an existing or restored session.

import type { SessionMode } from "../types/session";

export const SESSION_MODE_BY_PROVIDER_KEY = "session_mode_by_provider";

export type SessionModeByProvider = Record<string, SessionMode>;

/** Providers that have an optional Agent view. Everything else is terminal only. */
export const AGENT_VIEW_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

export function hasAgentView(providerId: string | null | undefined): boolean {
  return !!providerId && AGENT_VIEW_PROVIDERS.has(providerId);
}

/** Parse the stored map. Anything malformed is dropped, never thrown. */
export function parseSessionModeByProvider(raw: string | null | undefined): SessionModeByProvider {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SessionModeByProvider = {};
  for (const [provider, mode] of Object.entries(parsed as Record<string, unknown>)) {
    if (mode === "agent" || mode === "terminal") out[provider] = mode;
  }
  return out;
}

/** The mode the creator should preselect for a provider. Terminal unless the
 *  user last chose the Agent view for a provider that has one. */
export function preferredSessionMode(
  prefs: SessionModeByProvider,
  providerId: string | null | undefined,
): SessionMode {
  return hasAgentView(providerId) && prefs[providerId as string] === "agent" ? "agent" : "terminal";
}

/** Record the mode the user just created a session with. Returns a new map. */
export function rememberSessionMode(
  prefs: SessionModeByProvider,
  providerId: string,
  mode: SessionMode,
): SessionModeByProvider {
  return { ...prefs, [providerId]: hasAgentView(providerId) ? mode : "terminal" };
}
