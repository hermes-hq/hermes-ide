// ─── Session status -> inbox items ────────────────────────────────────
//
// F12. Follows every session's AgentStatus (the C0 event store) and keeps
// one inbox item per session in step with it:
//
//   needs_approval / needs_answer / plan_ready -> "blocked"
//   done_unread                                -> "ready"
//   anything else                              -> no item (the old one is resolved)
//
// Vendor-neutral by construction: it reads AgentStatus only, so a Claude
// hook, an OSC notification from any agent or a plugin all land the same.
//
// An item keeps its place (its createdAt) while the session stays in the
// same state with the same detail, so a status reported twice does not send
// the session to the back of the ⌘I queue. A "ready" item that was read
// (acknowledge) is not raised again until a new status arrives.

import {
  getSessionEventSnapshot,
  sessionIdsWithEvents,
  subscribeAllSessionEvents,
} from "../agent/contract/sessionEventStore";
import { listInboxItems, raiseInboxItem, resolveInboxItem, type InboxKind } from "../agent/contract/inbox";
import type { AgentStatus } from "../agent/contract/status";
import { inboxKindForStatus } from "./model";

/** The `source` of every item this bridge raises. */
export const STATUS_SOURCE = "status";

interface Raised {
  readonly itemId: string;
  readonly kind: InboxKind;
  readonly detail: string;
}

export interface StatusBridge {
  /** Mark a session's "ready" item as read (the person looked at it). */
  acknowledgeReady(sessionId: string): boolean;
  /** Forget a closed session. */
  forget(sessionId: string): void;
  stop(): void;
}

export function startStatusBridge(): StatusBridge {
  const raised = new Map<string, Raised>();
  /** The status object last handled per session (a new event = a new object). */
  const handled = new Map<string, AgentStatus>();

  const isOpen = (id: string) => listInboxItems().some((i) => i.id === id);

  function sync(sessionId: string): void {
    const snap = getSessionEventSnapshot(sessionId);
    if (handled.get(sessionId) === snap.status) return; // another kind of event landed
    handled.set(sessionId, snap.status);
    const kind = snap.version === 0 ? null : inboxKindForStatus(snap.status.kind);
    const detail = snap.status.detail;
    const prev = raised.get(sessionId);
    if (prev && kind === prev.kind && detail === prev.detail && isOpen(prev.itemId)) return;
    if (prev) {
      resolveInboxItem(prev.itemId);
      raised.delete(sessionId);
    }
    if (!kind) return;
    const item = raiseInboxItem({ kind, sessionId, detail, source: STATUS_SOURCE });
    raised.set(sessionId, { itemId: item.id, kind, detail });
  }

  for (const id of sessionIdsWithEvents()) sync(id);
  const unsubscribe = subscribeAllSessionEvents(sync);

  return {
    acknowledgeReady(sessionId) {
      const prev = raised.get(sessionId);
      if (!prev || prev.kind !== "ready") return false;
      raised.delete(sessionId);
      return resolveInboxItem(prev.itemId);
    },
    forget(sessionId) {
      const prev = raised.get(sessionId);
      if (prev) resolveInboxItem(prev.itemId);
      raised.delete(sessionId);
      handled.delete(sessionId);
    },
    stop() {
      unsubscribe();
      raised.clear();
      handled.clear();
    },
  };
}
