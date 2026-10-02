// ─── Which new inbox items notify, and how ────────────────────────────
//
// F12 + N16. Called with the open inbox items whenever they change; decides
// for each NEW item whether it shows an OS notification and, for Blocked on
// you items, whether it sends the away message (webhook, ntfy, Telegram).
//
//   muted              the session is muted (M in the inbox): nothing
//   suppressed-focused you are looking at that session in a focused window:
//                      no OS notification; a Blocked on you item still waits
//                      for its away message (below), as you may have
//                      stepped away
//   grouped            the session already has a notification out in the same
//                      section (Blocked on you / Ready for you) that you have
//                      not acted on: nothing new
//   sent               an OS notification; plus one away message when the
//                      item is Blocked on you (see below)
//
// The away message goes out only when Hermes is not in front of you: at once
// when no Hermes window has the keyboard focus, else once the item has waited
// unanswered for the delay you chose (Immediately / 2 min / 10 min; a focused
// window does not mean someone is sitting at it) or the window loses the
// focus first. Using Hermes (a key or a click, see activity()) shows you are
// there: the delay starts again from then. It is dropped when the item is
// answered or the session muted, and when you switch to the session it
// belongs to. tick() sends what is due; the attention center calls it on
// focus changes and on a timer.
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

/** "away-later": the away message of an item decided earlier went out now. */
export type NotifyDecision = "sent" | "suppressed-focused" | "muted" | "grouped" | "away-later";

/**
 * What an away message carries: the agent, the task name, the state and
 * where it works ("api-repo #2": the repository folder and the session's
 * number in it). Nothing else, never a prompt.
 */
export interface AwayPayload {
  readonly agent: string;
  readonly task: string;
  readonly state: string;
  readonly where: string;
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
  /**
   * How long a Blocked on you item may wait unanswered while a Hermes window
   * has the focus before its away message goes out anyway; 0 sends at once.
   */
  awayDelayMs(): number;
}

export const NOTIFY_LOG_CAP = 100;

export interface PendingAway {
  readonly itemId: string;
  readonly sessionId: string;
  /** When the delay started: the item was decided on, or you last used Hermes. */
  readonly since: number;
  /** Asked while you were looking at its session in a focused window. */
  readonly watched: boolean;
}

export interface Notifier {
  update(items: readonly InboxItem[]): void;
  /**
   * You looked at the session: its next request notifies again, and its
   * waiting away message is dropped (unless it was asked while you were
   * already looking at it: that one waits for the delay).
   */
  seen(sessionId: string): void;
  /** You used Hermes (a key, a click): every waiting away message's delay starts again. */
  activity(): void;
  /** Send the away messages that are due (the window lost the focus, or the delay passed). */
  tick(): void;
  /** Away messages waiting for the delay or for the window to lose the focus. */
  pendingAway(): readonly PendingAway[];
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
  /** itemId -> the item whose away message waits, since when, and whether it was asked in view. */
  const pending = new Map<string, { item: InboxItem; since: number; watched: boolean }>();

  const awayDue = (since: number): boolean => !deps.isWindowFocused() || deps.now() - since >= Math.max(0, deps.awayDelayMs());

  function record(item: InboxItem, decision: NotifyDecision, away: boolean): void {
    entries.push({ at: deps.now(), itemId: item.id, sessionId: item.sessionId, kind: item.kind, decision, away });
    if (entries.length > NOTIFY_LOG_CAP) entries.shift();
  }

  function decide(item: InboxItem): void {
    const sid = item.sessionId;
    if (isMuted(deps.mutes(), sid, deps.now())) return record(item, "muted", false);
    if (sid !== null && deps.isWindowFocused() && deps.activeSessionId() === sid) {
      // In view: no OS notification. But a focused window is not a person at
      // it, so the away message waits for the delay like any other (one per
      // session at a time).
      const queued = [...pending.values()].some((p) => p.item.sessionId === sid);
      const away = sectionOf(item.kind) === "blocked" && !queued && queueAway(item, true);
      return record(item, "suppressed-focused", away);
    }
    if (sid !== null && groups.has(groupKey(sid, item))) return record(item, "grouped", false);
    deps.showOs(deps.text(item), item);
    if (sid !== null) groups.add(groupKey(sid, item));
    const away = sid !== null && sectionOf(item.kind) === "blocked" && queueAway(item, false);
    record(item, "sent", away);
  }

  /** Send the item's away message now if it is due, else keep it waiting. True when sent. */
  function queueAway(item: InboxItem, watched: boolean): boolean {
    const since = deps.now();
    if (awayDue(since)) {
      deps.sendAway(deps.awayPayload(item));
      return true;
    }
    pending.set(item.id, { item, since, watched });
    return false;
  }

  function tick(): void {
    for (const [id, p] of [...pending]) {
      if (isMuted(deps.mutes(), p.item.sessionId, deps.now())) {
        pending.delete(id);
        continue;
      }
      if (!awayDue(p.since)) continue;
      pending.delete(id);
      deps.sendAway(deps.awayPayload(p.item));
      record(p.item, "away-later", true);
    }
  }

  return {
    update(items) {
      const open = new Set(items.map((i) => i.id));
      for (const id of [...seen]) if (!open.has(id)) seen.delete(id);
      // Answered (or gone): its away message is not needed any more.
      for (const id of [...pending.keys()]) if (!open.has(id)) pending.delete(id);
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
      for (const [id, p] of [...pending]) if (p.item.sessionId === sessionId && !p.watched) pending.delete(id);
    },
    activity() {
      const now = deps.now();
      for (const p of pending.values()) p.since = now;
    },
    tick,
    pendingAway: () => [...pending].map(([itemId, p]) => ({ itemId, sessionId: p.item.sessionId as string, since: p.since, watched: p.watched })),
    log: () => entries,
  };
}
