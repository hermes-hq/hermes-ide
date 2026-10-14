// ─── Session actions: which ones are chips ────────────────────────────
//
// The person pins actions (not commands), so a pin works across agents:
// "Review" is /code-review in Claude Code and /review in Codex. Stored in
// the settings table as a JSON array of action ids (`session_actions_pinned`),
// read once at startup with the other settings; until the person changes
// them, DEFAULT_PINNED. Destructive actions can never be pinned.

import { useSyncExternalStore } from "react";
import { setSetting, type SettingsMap } from "../api/settings";
import { ACTION_IDS, DEFAULT_PINNED, isActionId, isDestructiveAction, type SessionActionId } from "./catalog";

export const PINNED_SETTING = "session_actions_pinned";

let pinned: readonly SessionActionId[] = DEFAULT_PINNED;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** Pure: the pins a stored value means (unknown and destructive ids dropped, vocabulary order). */
export function pinsFrom(value: string | undefined | null): readonly SessionActionId[] {
  if (!value) return DEFAULT_PINNED;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return DEFAULT_PINNED;
    const keep = new Set(parsed.filter((id): id is SessionActionId => isActionId(id) && !isDestructiveAction(id)));
    return ACTION_IDS.filter((id) => keep.has(id));
  } catch {
    return DEFAULT_PINNED;
  }
}

export function initPinnedActions(settings: SettingsMap): void {
  pinned = pinsFrom(settings[PINNED_SETTING]);
  notify();
}

export function getPinnedActions(): readonly SessionActionId[] {
  return pinned;
}

/** Pin or unpin an action, at once and for every session. */
export function setActionPinned(action: SessionActionId, on: boolean): Promise<void> {
  if (isDestructiveAction(action)) return Promise.resolve();
  const next = new Set(pinned);
  if (on) next.add(action);
  else next.delete(action);
  pinned = ACTION_IDS.filter((id) => next.has(id));
  notify();
  return setSetting(PINNED_SETTING, JSON.stringify(pinned)).catch((err: unknown) => {
    console.warn("[session-actions] pins not saved:", err);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePinnedActions(): readonly SessionActionId[] {
  return useSyncExternalStore(subscribe, getPinnedActions, getPinnedActions);
}

export function _resetPinnedActionsForTest(): void {
  pinned = DEFAULT_PINNED;
  listeners.clear();
}
