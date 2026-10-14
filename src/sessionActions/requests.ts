// ─── Session actions: requests from elsewhere ─────────────────────────
//
// The command palette (⌘K) lists the focused session's commands ("Run in
// <session>: Compact"). It does not run them itself: it hands the pick to
// that session's action bar, which applies the same rules as a click (the
// agent must wait, a draft is never touched, a destructive command asks
// first in the Commands list) and shows the outcome where the person looks.

type Handler = (text: string) => void;

const handlers = new Map<string, Set<Handler>>();

/** A session's bar (terminal pane or agent composer) takes requests while it is shown. */
export function onSessionCommandRequest(sessionId: string, handler: Handler): () => void {
  let set = handlers.get(sessionId);
  if (!set) {
    set = new Set();
    handlers.set(sessionId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(sessionId);
  };
}

/** Whether a bar is there to take a request for the session. */
export function canRequestSessionCommand(sessionId: string): boolean {
  return (handlers.get(sessionId)?.size ?? 0) > 0;
}

/** Ask the session's bar to run `text` (one of its commands). False when no bar is shown. */
export function requestSessionCommand(sessionId: string, text: string): boolean {
  const set = handlers.get(sessionId);
  if (!set || set.size === 0) return false;
  for (const h of [...set]) h(text);
  return true;
}
