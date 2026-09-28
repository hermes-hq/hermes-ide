// ─── Session names the user gave (N16) ────────────────────────────────
//
// An away message may name the task, but never with words taken from a
// prompt. Unnamed Agent-view sessions are renamed after the first line of
// the first message (utils/autoSessionLabel.ts), and nothing on the session
// records that. So the away message carries a label only when it is the
// backend's "Session N" placeholder or exactly the name the user typed
// (session creator or rename), remembered here per session. Anything else,
// including every name from before this was recorded, is left out.
//
// Kept in this webview's storage: a lost entry only drops the name from the
// message, which is the safe direction.

import { isDefaultSessionLabel } from "../utils/autoSessionLabel";

const STORAGE_KEY = "hermes.attention.userLabels";

type LabelMap = Record<string, string>;

let cache: LabelMap | null = null;

function load(): LabelMap {
  if (cache) return cache;
  let parsed: LabelMap = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [id, label] of Object.entries(value)) if (typeof label === "string") parsed[id] = label;
    }
  } catch {
    parsed = {};
  }
  cache = parsed;
  return parsed;
}

function save(map: LabelMap): void {
  cache = map;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the name lives for this run only.
  }
}

/** Remember that the user named `sessionId` `label` themselves. */
export function rememberUserLabel(sessionId: string, label: string): void {
  const trimmed = label.trim();
  if (!sessionId || !trimmed) return;
  save({ ...load(), [sessionId]: trimmed });
}

/** Drop what is remembered for a session that closed. */
export function forgetUserLabel(sessionId: string): void {
  const map = load();
  if (!(sessionId in map)) return;
  const next = { ...map };
  delete next[sessionId];
  save(next);
}

/**
 * The label an away message may carry for this session: the placeholder or
 * the name the user gave, else "".
 */
export function shareableLabel(sessionId: string | null | undefined, label: string | null | undefined): string {
  const current = (label ?? "").trim();
  if (!current) return "";
  if (isDefaultSessionLabel(current)) return current;
  if (sessionId && load()[sessionId] === current) return current;
  return "";
}

export function _resetUserLabelsForTest(): void {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
