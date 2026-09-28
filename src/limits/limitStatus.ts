// ─── Usage limits (N19): the words for a limit, and its inbox item ────
//
// The backend turns what the agent reports (a rate-limited stop, the
// status line's reset time) into a `limit` event plus a `limited` status on
// the contract channel (src-tauri/src/limits.rs). Here the frontend says it
// in words, and keeps one `limit` item in the attention inbox per limited
// session, for as long as it is limited (docs/adr/004: N19 raises `limit`).

import { raiseInboxItem, resolveInboxItem } from "../agent/contract/inbox";
import {
  getSessionEventSnapshot,
  subscribeAnySessionEvent,
  type SessionEventSnapshot,
} from "../agent/contract/sessionEventStore";
import { getCurrentLanguage, translate } from "../i18n/registry";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A reset time for people: the clock time when it is within a day, with the
 * weekday when it is further out, with the date when it is a week or more
 * away. `timeZone` is for tests; the app uses the machine's.
 */
export function formatResetTime(
  resetsAt: number,
  now: number,
  locale: string = getCurrentLanguage(),
  timeZone?: string,
): string {
  const ahead = resetsAt - now;
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone };
  if (ahead >= 7 * DAY_MS) {
    options.month = "short";
    options.day = "numeric";
  } else if (ahead >= DAY_MS - 60 * 60 * 1000) {
    options.weekday = "short";
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(new Date(resetsAt));
  } catch {
    return new Intl.DateTimeFormat("en", options).format(new Date(resetsAt));
  }
}

/** Whether the session is limited, and the words for it; null when it is not. */
export function limitDescription(
  snapshot: SessionEventSnapshot,
  now: number,
  t: Translate = translate,
): { detail: string; resetsAt: number | null } | null {
  if (snapshot.status.kind !== "limited") return null;
  const resetsAt = snapshot.limit?.resetsAt ?? null;
  if (resetsAt === null) return { detail: t("limits.resetUnknown"), resetsAt };
  if (resetsAt <= now) return { detail: t("limits.resetPassed", { time: formatResetTime(resetsAt, now) }), resetsAt };
  return { detail: t("limits.resetsAt", { time: formatResetTime(resetsAt, now) }), resetsAt };
}

/**
 * Keep one `limit` inbox item per limited session: raised when a session
 * becomes limited, replaced when its reset time changes, resolved when the
 * limit clears or the session goes. Returns the stop function.
 */
export function startLimitInbox(now: () => number = () => Date.now(), t: Translate = translate): () => void {
  const open = new Map<string, { id: string; resetsAt: number | null }>();
  const update = (sessionId: string) => {
    const limit = limitDescription(getSessionEventSnapshot(sessionId), now(), t);
    const current = open.get(sessionId);
    if (current && (!limit || limit.resetsAt !== current.resetsAt)) {
      resolveInboxItem(current.id);
      open.delete(sessionId);
    }
    if (limit && !open.has(sessionId)) {
      const item = raiseInboxItem({ kind: "limit", sessionId, detail: limit.detail, source: "status" });
      open.set(sessionId, { id: item.id, resetsAt: limit.resetsAt });
    }
  };
  const unsubscribe = subscribeAnySessionEvent(update);
  return () => {
    unsubscribe();
    open.clear();
  };
}
