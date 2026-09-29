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
// A guess never says the person is blocked: a "needs approval" (or a
// question, or a plan) at guessed confidence — the OS layer's approval
// guess for an agent that reports none (Antigravity), a plugin's guess —
// neither raises nor keeps an item, so it sends no notification either.
//
// An item keeps its place (its createdAt) while the session stays in the
// same state with the same detail, so a status reported twice does not send
// the session to the back of the ⌘I queue. A "ready" item that was read
// (acknowledge) is not raised again until a new status arrives.

import {
  getSessionEventSnapshot,
  sessionIdsWithEvents,
  subscribeAllSessionEvents,
  type SessionEventSnapshot,
} from "../agent/contract/sessionEventStore";
import { listInboxItems, raiseInboxItem, resolveInboxItem, type InboxKind } from "../agent/contract/inbox";
import type { AgentStatus } from "../agent/contract/status";
import { inboxKindForStatus } from "./model";
import { isHeuristicSource, resumedIndex } from "../agent/status/deriveStatus";
import { userInputTimes } from "../agent/status/userInput";

const EXITED: AgentStatus = Object.freeze({ kind: "exited", confidence: "exact", detail: "" });
const QUIET: AgentStatus = Object.freeze({ kind: "idle", confidence: "guessed", detail: "" });

/**
 * The last status of a session that did not come from the terminal's own
 * heuristics (F10's TerminalProvider, source "pty"): those neither raise
 * nor resolve an item, so a shell prompt redrawn after an agent asked for
 * approval does not hide the request. An exit counts (it is a fact). Null
 * when the session has reported nothing else.
 *
 * One exception (deriveStatus, rule 6): once the agent visibly resumed
 * after a signal the person answered, the terminal's working guess stands in
 * for the signal (it resolves the item), and anything the terminal guesses
 * after it reads as quiet (a guess never raises an item).
 *
 * A guessed "blocked" report (see isGuessedBlock) is skipped like the
 * terminal's guesses: what was reported before it stands.
 */
export function trustedStatus(snap: SessionEventSnapshot, inputTimes: readonly number[] = userInputTimes(snap.sessionId)): AgentStatus | null {
  let latestGuess: AgentStatus | null = null;
  for (let i = snap.events.length - 1; i >= 0; i--) {
    const e = snap.events[i];
    if (e.type === "exit") return EXITED;
    if (e.type === "status" && isHeuristicSource(e.source)) {
      latestGuess ??= e.status;
      continue;
    }
    if (e.type === "status" && isGuessedBlock(e.status)) continue;
    if (e.type === "status") {
      if (latestGuess && resumedIndex(snap.events, i, inputTimes) >= 0) return latestGuess.kind === "working" ? latestGuess : QUIET;
      return e.status;
    }
  }
  return null;
}

/** A status that would block on the person, but only as a guess. */
export function isGuessedBlock(status: AgentStatus): boolean {
  return status.confidence === "guessed" && inboxKindForStatus(status.kind) === "blocked";
}

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
  const handled = new Map<string, AgentStatus | null>();

  const isOpen = (id: string) => listInboxItems().some((i) => i.id === id);

  function sync(sessionId: string): void {
    const status = trustedStatus(getSessionEventSnapshot(sessionId));
    if (handled.has(sessionId) && handled.get(sessionId) === status) return; // another kind of event landed
    handled.set(sessionId, status);
    const kind = status ? inboxKindForStatus(status.kind) : null;
    const detail = status?.detail ?? "";
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
