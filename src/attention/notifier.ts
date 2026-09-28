// ─── Which new inbox items notify, and how ────────────────────────────
//
// F12 + N16. Called with the open inbox items whenever they change; decides
// for each NEW item whether it shows an OS notification and, for Blocked on
// you items, whether it sends the away message (webhook, ntfy, Telegram).
//
//   muted              the session is muted (M in the inbox): nothing
//   suppressed-focused you are looking at that session in a focused window:
//                      nothing
//   grouped            the session already has a notification out in the same
//                      section (Blocked on you / Ready for you) that you have
//                      not acted on: nothing new
//   sent               an OS notification; plus one away message when the
//                      item is Blocked on you
//
// A group ends when the session has no open item left in that section (the
// agent moved on) or when you look at the session, so the next time it
// needs you it notifies again. A request replaced by another in one step
// (one edit approved, the next asked at once) stays in the group.
//
// Every decision is kept in a short log (read by the e2e hooks, so a
// real-app scenario can see what was decided and why).

import type { InboxItem } from "../agent/contract/inbox";
import { isMuted, sectionOf, type MuteMap } from "./model";

export type NotifyDecision = "sent" | "suppressed-focused" | "muted" | "grouped";

/** What an away message carries: the agent, the task name and the state. Nothing else. */
export interface AwayPayload {
  readonly agent: string;
  readonly task: string;
  readonly state: string;
}

export interface NotificationText {
  readonly title: string;
  readonly body: string;
}

export interface NotifyLogEntry {
  readonly at: number;
  readonly itemId: string;
  readonly sessionId: string | null;
  readonly kind: InboxItem["kind"];
  readonly decision: NotifyDecision;
  /** Whether an away message was handed to the sender for this item. */
  readonly away: boolean;
}

export interface NotifierDeps {
  now(): number;
  isWindowFocused(): boolean;
  activeSessionId(): string | null;
  mutes(): MuteMap;
  text(item: InboxItem): NotificationText;
  awayPayload(item: InboxItem): AwayPayload;
  showOs(text: NotificationText, item: InboxItem): void;
  sendAway(payload: AwayPayload): void;
}

export const NOTIFY_LOG_CAP = 100;

export interface Notifier {
  update(items: readonly InboxItem[]): void;
  /** You looked at the session: its next request notifies again. */
  seen(sessionId: string): void;
  log(): readonly NotifyLogEntry[];
}

function groupKey(sessionId: string, item: InboxItem): string {
  return `${sectionOf(item.kind)}:${sessionId}`;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  /** Items already decided on. */
  const seen = new Set<string>();
  /** "<section>:<sessionId>" of every open notification group. */
  const groups = new Set<string>();
  const entries: NotifyLogEntry[] = [];

  function record(item: InboxItem, decision: NotifyDecision, away: boolean): void {
    entries.push({ at: deps.now(), itemId: item.id, sessionId: item.sessionId, kind: item.kind, decision, away });
    if (entries.length > NOTIFY_LOG_CAP) entries.shift();
  }

  function decide(item: InboxItem): void {
    const sid = item.sessionId;
    if (isMuted(deps.mutes(), sid, deps.now())) return record(item, "muted", false);
    if (sid !== null && deps.isWindowFocused() && deps.activeSessionId() === sid) {
      return record(item, "suppressed-focused", false);
    }
    if (sid !== null && groups.has(groupKey(sid, item))) return record(item, "grouped", false);
    deps.showOs(deps.text(item), item);
    if (sid !== null) groups.add(groupKey(sid, item));
    const away = sid !== null && sectionOf(item.kind) === "blocked";
    if (away) deps.sendAway(deps.awayPayload(item));
    record(item, "sent", away);
  }

  return {
    update(items) {
      const open = new Set(items.map((i) => i.id));
      for (const id of [...seen]) if (!open.has(id)) seen.delete(id);
      const live = new Set(items.flatMap((i) => (i.sessionId === null ? [] : [groupKey(i.sessionId, i)])));
      for (const key of [...groups]) if (!live.has(key)) groups.delete(key);
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        decide(item);
      }
    },
    seen(sessionId) {
      groups.delete(`blocked:${sessionId}`);
      groups.delete(`ready:${sessionId}`);
    },
    log: () => entries,
  };
}
