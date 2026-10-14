// ─── Session actions: what the person actually sent ───────────────────
//
// The Commands list's "Recent" section shows only commands the person sent:
// a chip, a pick from the list or the palette, or a line starting with "/"
// they typed and entered at the agent's prompt themselves (TerminalPool
// reports those; only a word that names one of the agent's commands is
// kept, never the rest of the line). Nothing is read from the agent's
// output. Kept on this device in the settings table, per agent, newest
// first, at most RECENT_LIMIT (`session_commands_recent`, not exported).
// Each session also remembers its own sends while the app runs (the context
// panel lists them).

import { useSyncExternalStore } from "react";
import { setSetting, type SettingsMap } from "../api/settings";

export const RECENT_SETTING = "session_commands_recent";
export const RECENT_LIMIT = 8;
/** How many sends a session remembers for the context panel. */
export const SESSION_SENDS_LIMIT = 10;

type RecentMap = Readonly<Record<string, readonly string[]>>;

export interface CommandSend {
  /** What was typed ("/compact"). */
  text: string;
  /** Where the person sent it from. */
  via: "chip" | "list" | "palette" | "typed";
  at: number;
}

let recent: RecentMap = {};
const sessionSends = new Map<string, readonly CommandSend[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = Object.freeze([]);
const NO_SENDS: readonly CommandSend[] = Object.freeze([]);

function notify(): void {
  for (const l of [...listeners]) l();
}

/** Pure: the per-agent lists a stored value means (malformed parts dropped). */
export function recentFrom(value: string | undefined | null): RecentMap {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, readonly string[]> = {};
    for (const [agent, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const texts = list.filter((x): x is string => typeof x === "string" && /^[/$][\w:. -]{1,80}$/.test(x));
      if (texts.length) out[agent] = texts.slice(0, RECENT_LIMIT);
    }
    return out;
  } catch {
    return {};
  }
}

/** Pure: the list after sending `text`: moved (or added) to the front, capped. */
export function withSent(list: readonly string[], text: string): readonly string[] {
  return [text, ...list.filter((x) => x !== text)].slice(0, RECENT_LIMIT);
}

export function initRecentCommands(settings: SettingsMap): void {
  recent = recentFrom(settings[RECENT_SETTING]);
  notify();
}

export function recordCommandSent(sessionId: string, agentId: string, text: string, via: CommandSend["via"], now: number = Date.now()): void {
  recent = { ...recent, [agentId]: withSent(recent[agentId] ?? EMPTY, text) };
  const sends = [{ text, via, at: now }, ...(sessionSends.get(sessionId) ?? NO_SENDS)].slice(0, SESSION_SENDS_LIMIT);
  sessionSends.set(sessionId, sends);
  notify();
  setSetting(RECENT_SETTING, JSON.stringify(recent)).catch((err: unknown) => {
    console.warn("[session-actions] recent commands not saved:", err);
  });
}

export function getRecentCommands(agentId: string | null): readonly string[] {
  return (agentId && recent[agentId]) || EMPTY;
}

export function getSessionSends(sessionId: string): readonly CommandSend[] {
  return sessionSends.get(sessionId) ?? NO_SENDS;
}

export function forgetSessionSends(sessionId: string): void {
  if (sessionSends.delete(sessionId)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRecentCommands(agentId: string | null): readonly string[] {
  return useSyncExternalStore(subscribe, () => getRecentCommands(agentId), () => getRecentCommands(agentId));
}

export function useSessionSends(sessionId: string): readonly CommandSend[] {
  return useSyncExternalStore(subscribe, () => getSessionSends(sessionId), () => getSessionSends(sessionId));
}

export function _resetRecentCommandsForTest(): void {
  recent = {};
  sessionSends.clear();
  listeners.clear();
}
