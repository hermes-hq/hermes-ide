/**
 * Long-lived per-session store for the AgentSessionView reducer state.
 *
 * Why this exists
 * ───────────────
 * `AgentSessionView` previously held its event-stream state in a local
 * `useReducer`.  That was fine until you actually used the app: the
 * sidebar lets users swap which session is active, and switching to a
 * different session unmounts the previous session's pane.  When the
 * component unmounts, the reducer is destroyed and the Tauri event
 * subscription tears down.  Events that arrive while the view is gone
 * are dropped on the floor (Tauri broadcasts to live listeners only),
 * and on remount the user sees an empty "AWAITING FIRST SIGNAL"
 * timeline even though Claude finished a turn in the background.
 *
 * The store fixes both halves:
 *
 *   1. **State persists across remounts.**  We hold the reducer state
 *      in a module-level `Map<sessionId, AgentSessionStore>` so a
 *      remount of `AgentSessionView` reads back the accumulated
 *      messages instead of starting from `emptyState()`.
 *
 *   2. **Listeners persist across remounts.**  The store sets up the
 *      Tauri listeners on creation and keeps them attached until the
 *      session is explicitly destroyed (via `closeSession`).  Events
 *      that arrive while no view is mounted are folded into state
 *      immediately and shown the next time a view subscribes.
 *
 * The store also owns:
 *
 *   • **Pending permission requests** (v1.1.2 fix C1).  The interactive
 *     dispatcher used to keep `_hermes_perm_request` events in local
 *     state; switching sessions deleted the pending request and the
 *     bridge waited forever.  We hold them here instead so they
 *     survive remount.
 *   • **An init "generation" counter** (v1.1.2 fix H1).  When the
 *     subprocess respawns, the OLD subprocess's `agent-exit` event can
 *     arrive AFTER the NEW init event because Tauri broadcasts each
 *     channel independently.  We bump generation on every init and
 *     ignore exit events stamped with an older generation.
 *   • **A capped stderr buffer** (v1.1.2 fix H5) so a chatty subprocess
 *     can't OOM the renderer.
 */

import type { AgentEvent } from "./types";
import { emptyState, freezePendingThinking, reduceEvent } from "./messageStore";
import type { AgentSessionState } from "./messageStore";
import { isPermRequest, type PermRequest } from "../utils/permissionRequest";

export interface AgentExitInfo {
  code: number | null;
  signal: string | null;
}

/** Frozen view of everything an AgentSessionView needs to render. */
export interface AgentViewSnapshot {
  state: AgentSessionState;
  stderr: string;
  exit: AgentExitInfo | null;
  /** Permission request waiting on the user, or null when none.  Kept
   *  in the store rather than the dispatcher's local React state so a
   *  session switch doesn't lose the request and leave the bridge
   *  hanging on `canUseTool`. */
  pendingPermRequest: PermRequest | null;
}

type Unlisten = () => void;
type ListenFn = <T>(
  event: string,
  handler: (msg: { payload: T }) => void,
) => Promise<Unlisten>;

const stores = new Map<string, AgentSessionStore>();

/** Cap stderr at 1 MiB.  Subprocess output past that is summarized and
 *  the head is dropped, keeping the most-recent diagnostics — which is
 *  what the user actually needs when triaging a hang. */
const STDERR_MAX_BYTES = 1 << 20;

/** Window after a fresh `init` event during which we treat any
 *  incoming `agent-exit` event as belonging to the *previous*
 *  subprocess and discard it.  300 ms is comfortably wider than the
 *  observed event-loop reordering window in production traces. */
const POST_INIT_EXIT_GRACE_MS = 300;

/** Header prepended to a truncated stderr buffer.  Computed once so we
 *  can subtract its byte length from `STDERR_MAX_BYTES` when slicing —
 *  otherwise the returned buffer would exceed the cap by the header
 *  length on every truncation (fix B4). */
const STDERR_TRUNC_HEADER =
  `[stderr truncated; showing last ${STDERR_MAX_BYTES} bytes]\n`;

export function _capStderr(buf: string, chunk: string): string {
  // Fast path: the common case is small chunks well under the cap.
  if (buf.length + chunk.length <= STDERR_MAX_BYTES) return buf + chunk;
  // Otherwise we keep the tail (most-recent N bytes).  The header
  // makes it obvious to anyone reading the stderr panel why earlier
  // output is gone.  We subtract the header length so the returned
  // buffer stays at or under STDERR_MAX_BYTES (fix B4).
  const combined = buf + chunk;
  const keepBytes = STDERR_MAX_BYTES - STDERR_TRUNC_HEADER.length;
  const keep = combined.slice(combined.length - keepBytes);
  return `${STDERR_TRUNC_HEADER}${keep}`;
}

export class AgentSessionStore {
  private snapshot: AgentViewSnapshot;
  private listeners = new Set<() => void>();
  private unlisteners: Unlisten[] = [];
  private destroyed = false;
  /** Monotonic counter incremented on every `init` event.  Exit events
   *  read this at delivery time; if a fresh init has arrived since the
   *  exit was generated, the exit is presumed stale (cross-channel
   *  reordering of a respawn) and ignored. */
  private initGeneration = 0;
  private lastInitAt = 0;

  constructor(public readonly sessionId: string, listen: ListenFn) {
    this.snapshot = {
      state: emptyState(),
      stderr: "",
      exit: null,
      pendingPermRequest: null,
    };

    // Subscribe up-front so events that arrive while no view is mounted
    // are still folded into state.  The store's lifetime is tied to the
    // session, not to any individual React component.
    listen<AgentEvent>(`agent-event-${sessionId}`, (msg) => {
      if (this.destroyed) return;
      const payload = msg.payload;

      // Pending perm request capture (fix C1).  Lives in the store so
      // a session-switch unmount doesn't drop the request on the
      // floor — the bridge's canUseTool would otherwise hang until
      // session close.
      if (isPermRequest(payload)) {
        this.snapshot = { ...this.snapshot, pendingPermRequest: payload };
        // Don't fold perm-request envelopes into the message stream —
        // they're metadata, not chat content.  Notify and exit.
        this.notify();
        return;
      }

      this.snapshot = {
        ...this.snapshot,
        state: reduceEvent(this.snapshot.state, payload),
      };
      // Drop the locally-cached exitInfo when a fresh init arrives —
      // a new init session_id means the agent is alive again, so any
      // prior exit notice is stale.  Bump the generation counter so
      // late-arriving exit events from the old subprocess can be
      // recognised as stale (fix H1).
      const ev = payload as { type?: string; subtype?: string };
      if (ev?.type === "system" && ev?.subtype === "init") {
        this.initGeneration += 1;
        this.lastInitAt = Date.now();
        // Bridge respawn: clear any pending permission request from the
        // dead bridge.  Otherwise the modal would still be showing the
        // old request id, and clicking allow/deny would write a
        // _hermes_perm_response that the new bridge has never heard of
        // (a no-op), leaving the modal stuck open (fix B1).
        this.snapshot = {
          ...this.snapshot,
          exit: null,
          stderr: "",
          pendingPermRequest: null,
        };
      }
      this.notify();
    }).then((un) => this.collect(un)).catch(() => undefined);

    listen<string>(`agent-stderr-${sessionId}`, (msg) => {
      if (this.destroyed) return;
      // Empty chunk: skip the snapshot allocation so React's
      // useSyncExternalStore doesn't re-render on every keepalive
      // (fix B3).
      if (msg.payload.length === 0) return;
      this.snapshot = {
        ...this.snapshot,
        stderr: _capStderr(this.snapshot.stderr, msg.payload),
      };
      this.notify();
    }).then((un) => this.collect(un)).catch(() => undefined);

    listen<AgentExitInfo>(`agent-exit-${sessionId}`, (msg) => {
      if (this.destroyed) return;
      // Cross-channel reordering protection (fix H1): if a fresh init
      // arrived very recently, this exit event almost certainly came
      // from the prior subprocess and would otherwise paint a phantom
      // "agent exited" banner over a perfectly healthy new bridge.
      const sinceInit = Date.now() - this.lastInitAt;
      if (this.lastInitAt > 0 && sinceInit < POST_INIT_EXIT_GRACE_MS) {
        // Drop silently — the new bridge's init already cleared exit.
        return;
      }
      this.snapshot = {
        ...this.snapshot,
        exit: msg.payload,
        state: freezeStreamingOnExit(this.snapshot.state),
      };
      this.notify();
    }).then((un) => this.collect(un)).catch(() => undefined);
  }

  private collect(un: Unlisten) {
    if (this.destroyed) {
      // Race: destroy() called before listen() resolved — clean up now.
      try { un(); } catch { /* already detached */ }
      return;
    }
    this.unlisteners.push(un);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** External-store contract for `useSyncExternalStore`. */
  getSnapshot = (): AgentViewSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** Test hook + manual "Start fresh" button — clears the local
   *  exit / stderr buffers without touching the messages list. */
  clearExitNotice = () => {
    if (this.snapshot.exit === null && this.snapshot.stderr === "") return;
    this.snapshot = { ...this.snapshot, exit: null, stderr: "" };
    this.notify();
  };

  /** Cleared when the user resolves a perm request (allow / deny) so
   *  the modal disappears.  Also fired by the dispatcher BEFORE the
   *  envelope is sent so a stalled IPC can't keep the modal clickable
   *  for a double-decision (fix H6). */
  clearPendingPermRequest = () => {
    if (this.snapshot.pendingPermRequest === null) return;
    this.snapshot = { ...this.snapshot, pendingPermRequest: null };
    this.notify();
  };

  /** Wholesale reset — used when respawning into a fresh session. */
  reset = () => {
    this.snapshot = {
      state: emptyState(),
      stderr: "",
      exit: null,
      pendingPermRequest: null,
    };
    this.notify();
  };

  /** Test hook: feed an event directly without going through Tauri. */
  injectEvent = (event: AgentEvent) => {
    if (isPermRequest(event)) {
      this.snapshot = { ...this.snapshot, pendingPermRequest: event };
      this.notify();
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      state: reduceEvent(this.snapshot.state, event),
    };
    const ev = event as { type?: string; subtype?: string };
    if (ev?.type === "system" && ev?.subtype === "init") {
      this.initGeneration += 1;
      this.lastInitAt = Date.now();
      this.snapshot = { ...this.snapshot, exit: null, stderr: "" };
    }
    this.notify();
  };

  /** Test hook: simulate the stderr stream. */
  injectStderr = (chunk: string) => {
    this.snapshot = {
      ...this.snapshot,
      stderr: _capStderr(this.snapshot.stderr, chunk),
    };
    this.notify();
  };

  /** Test hook: simulate an exit event. */
  injectExit = (info: AgentExitInfo) => {
    const sinceInit = Date.now() - this.lastInitAt;
    if (this.lastInitAt > 0 && sinceInit < POST_INIT_EXIT_GRACE_MS) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      exit: info,
      state: freezeStreamingOnExit(this.snapshot.state),
    };
    this.notify();
  };

  /** Test hook: peek at the init generation counter. */
  getInitGeneration = () => this.initGeneration;

  destroy() {
    this.destroyed = true;
    for (const un of this.unlisteners) {
      try { un(); } catch { /* already detached */ }
    }
    this.unlisteners = [];
    this.listeners.clear();
  }
}

/**
 * Get-or-create the per-session store.  Idempotent: a remount of the
 * AgentSessionView returns the existing store rather than spinning up a
 * fresh one with `emptyState()`.
 *
 * The optional `listen` injector lets tests substitute a synchronous
 * stub for the Tauri `listen` API without touching the global registry
 * shape.
 */
export function getOrCreateAgentSessionStore(
  sessionId: string,
  listen: ListenFn,
): AgentSessionStore {
  let store = stores.get(sessionId);
  if (!store) {
    store = new AgentSessionStore(sessionId, listen);
    stores.set(sessionId, store);
  }
  return store;
}

/** Test-only: peek at the registry without taking ownership. */
export function peekAgentSessionStore(
  sessionId: string,
): AgentSessionStore | undefined {
  return stores.get(sessionId);
}

/** Tear down the store for a session.  Called from `closeSession` so
 *  the long-lived listeners don't leak when the session is removed. */
export function destroyAgentSessionStore(sessionId: string): void {
  const store = stores.get(sessionId);
  if (!store) return;
  store.destroy();
  stores.delete(sessionId);
}

/**
 * Freeze in-flight streaming state when the bridge subprocess exits.
 *
 * Normally the `result` event clears `streamingMessageId`, empties
 * `runningToolUseIds`, and freezes thinking timers — that's what stops
 * the heartbeat cursor blinking and the elapsed counters ticking when a
 * turn ends.  When the subprocess dies WITHOUT a result event (signal
 * kill, abort, crash), the agent-exit channel fires but the reducer
 * never gets a clearing event, so the cursor blinks forever and any
 * thinking timer keeps incrementing in the UI.
 *
 * This helper applies the same freeze that `result` would have, so the
 * UI settles even on an abnormal exit.  Idempotent: returns the same
 * state object when nothing needs clearing, so React identity-based
 * memoization stays cheap.
 *
 * Exported for tests.
 */
export function freezeStreamingOnExit(state: AgentSessionState): AgentSessionState {
  const needsFreeze =
    state.streamingMessageId !== null
    || state.runningToolUseIds.size > 0
    || state.thinkingStartedAt.size > 0;
  if (!needsFreeze) return state;
  const now = Date.now();
  const { thinkingStartedAt, thinkingElapsed } = freezePendingThinking(
    state.thinkingStartedAt,
    state.thinkingElapsed,
    now,
  );
  return {
    ...state,
    streamingMessageId: null,
    runningToolUseIds:
      state.runningToolUseIds.size === 0
        ? state.runningToolUseIds
        : new Set(),
    thinkingStartedAt,
    thinkingElapsed,
  };
}

/** Test-only utility: reset the global registry.  Real callers should
 *  use `destroyAgentSessionStore` per session. */
export function _resetAgentSessionStoresForTest(): void {
  for (const store of stores.values()) {
    store.destroy();
  }
  stores.clear();
}
