// ─── Attention inbox: the rules, as pure functions ────────────────────
//
// F12 (attention inbox). Everything here is a pure function of the inbox
// items (src/agent/contract/inbox.ts), the per-session mutes and the time,
// so the order ⌘I visits sessions, what the badge counts and which section
// an item sits in are table-tested without React or Tauri.
//
// Two sections:
//   Blocked on you — every kind except "ready": an approval, a question, a
//                    gate, an error, a limit. The badge counts these.
//   Ready for you  — "ready": an agent finished and you have not looked.
//
// Both are oldest first. A muted session's items stay listed (marked muted)
// but are left out of the badge count, the ⌘I cycle and every notification.

import type { InboxItem, InboxKind } from "../agent/contract/inbox";
import type { AgentStatusKind } from "../agent/contract/status";

export type AttentionSection = "blocked" | "ready";

/** How long M mutes a session. */
export const MUTE_DURATION_MS = 60 * 60 * 1000;

/** sessionId -> muted until (epoch ms). */
export type MuteMap = ReadonlyMap<string, number>;

export function sectionOf(kind: InboxKind): AttentionSection {
  return kind === "ready" ? "ready" : "blocked";
}

/**
 * The inbox item a session's status raises (F12 owns only these): a person
 * must answer something -> blocked; a turn finished unseen -> ready. Other
 * blocking statuses (gate, check_failed, error, limited) are raised by the
 * features that own them (F28, F27, N19), so they are not doubled here.
 */
export function inboxKindForStatus(kind: AgentStatusKind): InboxKind | null {
  switch (kind) {
    case "needs_approval":
    case "needs_answer":
    case "plan_ready":
      return "blocked";
    case "done_unread":
      return "ready";
    default:
      return null;
  }
}

export function isMuted(mutes: MuteMap, sessionId: string | null, now: number): boolean {
  if (sessionId === null) return false;
  const until = mutes.get(sessionId);
  return until !== undefined && until > now;
}

function byAge(a: InboxItem, b: InboxItem): number {
  return a.createdAt - b.createdAt;
}

export interface AttentionGroups {
  readonly blocked: readonly InboxItem[];
  readonly ready: readonly InboxItem[];
}

/** Items split into the two sections, each oldest first (stable for ties). */
export function groupInbox(items: readonly InboxItem[]): AttentionGroups {
  const blocked: InboxItem[] = [];
  const ready: InboxItem[] = [];
  for (const item of items) (sectionOf(item.kind) === "ready" ? ready : blocked).push(item);
  return { blocked: blocked.sort(byAge), ready: ready.sort(byAge) };
}

/** What the title-bar badge and the dock badge show: open, unmuted Blocked on you items. */
export function blockedCount(items: readonly InboxItem[], mutes: MuteMap, now: number): number {
  let n = 0;
  for (const item of items) {
    if (sectionOf(item.kind) === "blocked" && !isMuted(mutes, item.sessionId, now)) n++;
  }
  return n;
}

/**
 * Sessions blocked on you, in the order ⌘I visits them: by their oldest
 * blocked item, oldest first. Muted sessions and workspace items (no
 * session) are left out.
 */
export function blockedSessionOrder(items: readonly InboxItem[], mutes: MuteMap, now: number): string[] {
  const order: string[] = [];
  for (const item of groupInbox(items).blocked) {
    if (item.sessionId === null || isMuted(mutes, item.sessionId, now)) continue;
    if (!order.includes(item.sessionId)) order.push(item.sessionId);
  }
  return order;
}

/**
 * The session ⌘I jumps to from `current`: the next blocked session after it
 * in blockedSessionOrder, wrapping to the oldest; the oldest when `current`
 * is not blocked. Null when nothing is blocked.
 */
export function nextBlockedSession(
  items: readonly InboxItem[],
  mutes: MuteMap,
  now: number,
  current: string | null,
): string | null {
  const order = blockedSessionOrder(items, mutes, now);
  if (order.length === 0) return null;
  const i = current === null ? -1 : order.indexOf(current);
  return order[(i + 1) % order.length];
}

/** The list the inbox renders, top to bottom: Blocked on you, then Ready for you. */
export function inboxRows(items: readonly InboxItem[]): InboxItem[] {
  const { blocked, ready } = groupInbox(items);
  return [...blocked, ...ready];
}
