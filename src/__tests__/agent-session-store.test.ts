/**
 * Tests for the long-lived per-session agent message store.
 *
 * Regression scope:
 *   - v1.1.0: switching sessions in the sidebar unmounted
 *     AgentSessionView, dropped its `useReducer` state, and showed
 *     "AWAITING FIRST SIGNAL" on remount even when Claude had already
 *     finished a turn in the background.  The store fixes this by
 *     keeping state + listeners alive across remounts, scoped per
 *     sessionId, until the session is closed.
 *
 *   - Listeners must keep folding events even when no React component
 *     is subscribed (the user might be on another session when the
 *     reply lands).
 *
 *   - destroy() must clean up listeners so the registry doesn't leak
 *     after `closeSession`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AgentSessionStore,
  getOrCreateAgentSessionStore,
  destroyAgentSessionStore,
  peekAgentSessionStore,
  _resetAgentSessionStoresForTest,
} from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";

type StubListenerHandle = {
  attached: boolean;
  fire: (payload: unknown) => void;
};

interface StubBus {
  channels: Map<string, Set<StubListenerHandle>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listen: <T>(name: string, handler: (msg: { payload: T }) => void) => Promise<() => void>;
}

function makeStubBus(): StubBus {
  const channels = new Map<string, Set<StubListenerHandle>>();
  return {
    channels,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listen: <T,>(name: string, handler: (msg: { payload: T }) => void) => {
      let attached = true;
      const handle: StubListenerHandle = {
        get attached() {
          return attached;
        },
        set attached(v: boolean) {
          attached = v;
        },
        fire: (p: unknown) => handler({ payload: p as T }),
      };
      const set = channels.get(name) ?? new Set<StubListenerHandle>();
      set.add(handle);
      channels.set(name, set);
      return Promise.resolve(() => {
        handle.attached = false;
        set.delete(handle);
      });
    },
  };
}

function makeInitEvent(sessionId: string): AgentEvent {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    apiKeySource: "anthropic",
    output_style: "default",
    slash_commands: [],
  } as unknown as AgentEvent;
}

function makeAssistantEvent(messageId: string, text: string): AgentEvent {
  return {
    type: "assistant",
    message: {
      id: messageId,
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as AgentEvent;
}

beforeEach(() => {
  _resetAgentSessionStoresForTest();
});

describe("AgentSessionStore", () => {
  it("starts with an empty snapshot", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    // Wait a tick so the constructor's listen() promises resolve and
    // attach the unlisteners.
    await Promise.resolve();
    const snap = store.getSnapshot();
    expect(snap.state.messages).toHaveLength(0);
    expect(snap.stderr).toBe("");
    expect(snap.exit).toBeNull();
  });

  it("subscribes to all three Tauri channels for the session", async () => {
    const bus = makeStubBus();
    new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    expect(bus.channels.has("agent-event-s1")).toBe(true);
    expect(bus.channels.has("agent-stderr-s1")).toBe(true);
    expect(bus.channels.has("agent-exit-s1")).toBe(true);
  });

  it("folds events into snapshot state and notifies subscribers", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const onChange = vi.fn();
    store.subscribe(onChange);

    const eventChannel = bus.channels.get("agent-event-s1")!;
    const handle = [...eventChannel][0];
    handle.fire(makeAssistantEvent("m1", "hello"));

    expect(onChange).toHaveBeenCalled();
    const snap = store.getSnapshot();
    expect(snap.state.messages).toHaveLength(1);
    expect(snap.state.messages[0].role).toBe("assistant");
  });

  it("KEY REGRESSION: holds events while no component is subscribed", async () => {
    // Mirrors the user-visible bug: switching to another session
    // unsubscribes the AgentSessionView, but the store's own
    // listener stays attached so events arriving in between are
    // captured.  When the view remounts via getOrCreateAgentSessionStore,
    // it reads the accumulated state.
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    // Component-style subscriber that mounts, unmounts, then remounts.
    const sub1 = vi.fn();
    const unsub1 = store.subscribe(sub1);
    expect(sub1).toHaveBeenCalledTimes(0);
    unsub1(); // user switched to a different session

    const ev = bus.channels.get("agent-event-s1")!;
    [...ev][0].fire(makeAssistantEvent("m1", "first reply"));

    // Remount: snapshot already contains the message.
    const sub2 = vi.fn();
    store.subscribe(sub2);
    expect(store.getSnapshot().state.messages).toHaveLength(1);
  });

  it("clears stderr + exit on a fresh init event (model swap recovery)", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectStderr("old-bridge died\n");
    store.injectExit({ code: 1, signal: null });
    expect(store.getSnapshot().stderr).not.toBe("");
    expect(store.getSnapshot().exit).not.toBeNull();

    const ev = bus.channels.get("agent-event-s1")!;
    [...ev][0].fire(makeInitEvent("new-uuid"));

    expect(store.getSnapshot().stderr).toBe("");
    expect(store.getSnapshot().exit).toBeNull();
  });

  it("appends stderr chunks across multiple emissions", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const ch = bus.channels.get("agent-stderr-s1")!;
    [...ch][0].fire("partial 1\n");
    [...ch][0].fire("partial 2\n");
    expect(store.getSnapshot().stderr).toBe("partial 1\npartial 2\n");
  });

  it("clearExitNotice() drops exit + stderr without touching messages", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectEvent(makeAssistantEvent("m1", "hi"));
    store.injectStderr("some warning\n");
    store.injectExit({ code: 1, signal: null });

    store.clearExitNotice();

    const snap = store.getSnapshot();
    expect(snap.state.messages).toHaveLength(1);
    expect(snap.exit).toBeNull();
    expect(snap.stderr).toBe("");
  });

  it("destroy() detaches every listener", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const handles = [
      ...bus.channels.get("agent-event-s1")!,
      ...bus.channels.get("agent-stderr-s1")!,
      ...bus.channels.get("agent-exit-s1")!,
    ];
    for (const h of handles) {
      expect(h.attached).toBe(true);
    }

    store.destroy();

    for (const h of handles) {
      expect(h.attached).toBe(false);
    }
  });

  it("destroy() before listen resolves still cleans up", async () => {
    // Race: getOrCreateAgentSessionStore + destroyAgentSessionStore
    // called in the same tick (e.g., session opened then immediately
    // closed).  The unlisteners arrive after destroy(); we need to
    // tear them down on arrival rather than leak.
    const bus = makeStubBus();
    const store = new AgentSessionStore("race", bus.listen);
    store.destroy(); // before the listen() Promises resolve
    await Promise.resolve();
    await Promise.resolve();
    // No listeners should remain attached on the bus.
    const eventCh = bus.channels.get("agent-event-race");
    if (eventCh) {
      for (const h of eventCh) expect(h.attached).toBe(false);
    }
  });

  it("does not fold events received after destroy()", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const ch = bus.channels.get("agent-event-s1")!;
    const handle = [...ch][0];
    store.destroy();
    handle.fire(makeAssistantEvent("late", "after destroy"));
    expect(store.getSnapshot().state.messages).toHaveLength(0);
  });
});

describe("getOrCreateAgentSessionStore registry", () => {
  it("returns the SAME store on repeated lookups for the same session", async () => {
    const bus = makeStubBus();
    const a = getOrCreateAgentSessionStore("sx", bus.listen);
    const b = getOrCreateAgentSessionStore("sx", bus.listen);
    expect(a).toBe(b);
  });

  it("creates separate stores per session id", async () => {
    const bus = makeStubBus();
    const a = getOrCreateAgentSessionStore("s1", bus.listen);
    const b = getOrCreateAgentSessionStore("s2", bus.listen);
    expect(a).not.toBe(b);
  });

  it("KEY REGRESSION: state survives unmount → remount of the consumer", async () => {
    // The exact user flow that broke: a session has a message in it,
    // user switches away (consumer unsubscribes), more events stream
    // in, user switches back (consumer remounts and calls
    // getOrCreate).  The store must hand back the accumulated state.
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("sx", bus.listen);
    await Promise.resolve();
    const consumer1 = vi.fn();
    const unsub = store.subscribe(consumer1);
    unsub(); // user switched sessions
    const ch = bus.channels.get("agent-event-sx")!;
    [...ch][0].fire(makeAssistantEvent("m1", "while you were away"));

    // User switches back — same store, accumulated state intact.
    const same = getOrCreateAgentSessionStore("sx", bus.listen);
    expect(same).toBe(store);
    expect(same.getSnapshot().state.messages).toHaveLength(1);
  });

  it("destroyAgentSessionStore() removes the entry from the registry", async () => {
    const bus = makeStubBus();
    getOrCreateAgentSessionStore("sx", bus.listen);
    expect(peekAgentSessionStore("sx")).toBeDefined();
    destroyAgentSessionStore("sx");
    expect(peekAgentSessionStore("sx")).toBeUndefined();
  });

  it("getOrCreateAgentSessionStore() after destroy creates a fresh store", async () => {
    const bus = makeStubBus();
    const a = getOrCreateAgentSessionStore("sx", bus.listen);
    destroyAgentSessionStore("sx");
    const b = getOrCreateAgentSessionStore("sx", bus.listen);
    expect(b).not.toBe(a);
  });
});

// ─────────────────────────────────────────────────────────────────
// REGRESSION: subprocess exit without a result event must clear the
// streaming cursor and freeze thinking timers — the symptom was a
// blue heartbeat cursor that kept blinking forever after a turn
// ended via signal kill / abort instead of a normal `result`.
// ─────────────────────────────────────────────────────────────────
describe("AgentSessionStore — exit-without-result freezes streaming state", () => {
  beforeEach(() => {
    _resetAgentSessionStoresForTest();
  });

  it("clears streamingMessageId on exit without a prior result event", async () => {
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("sx", bus.listen);
    await Promise.resolve();

    // Mid-stream assistant event with stop_reason: null leaves cursor on.
    store.injectEvent({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "partial reply" }],
        stop_reason: null,
      },
      session_id: "s",
      uuid: "u-m1",
    } as unknown as AgentEvent);
    expect(store.getSnapshot().state.streamingMessageId).toBe("m1");

    // Subprocess dies without sending a result event.
    store.injectExit({ code: null, signal: "SIGTERM" });

    expect(store.getSnapshot().state.streamingMessageId).toBeNull();
    expect(store.getSnapshot().exit).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("empties runningToolUseIds on exit without a prior result event", async () => {
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("sx", bus.listen);
    await Promise.resolve();

    // Tool issued but its result never arrived — runningToolUseIds = {tu_1}.
    store.injectEvent({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        model: "m",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
        stop_reason: null,
      },
      session_id: "s",
      uuid: "u-m1",
    } as unknown as AgentEvent);
    expect(store.getSnapshot().state.runningToolUseIds.has("tu_1")).toBe(true);

    store.injectExit({ code: 1, signal: null });
    expect(store.getSnapshot().state.runningToolUseIds.size).toBe(0);
  });

  it("freezes thinking timers on exit without a prior result event", async () => {
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("sx", bus.listen);
    await Promise.resolve();

    // A thinking block opened but never closed.
    store.injectEvent({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        model: "m",
        content: [{ type: "thinking", thinking: "still going" }],
        stop_reason: null,
      },
      session_id: "s",
      uuid: "u-m1",
    } as unknown as AgentEvent);
    expect(store.getSnapshot().state.thinkingStartedAt.size).toBe(1);

    store.injectExit({ code: null, signal: "SIGKILL" });
    expect(store.getSnapshot().state.thinkingStartedAt.size).toBe(0);
    // Frozen elapsed values are captured so the UI can render a final value.
    expect(store.getSnapshot().state.thinkingElapsed.has("m1:0")).toBe(true);
  });

  it("is a no-op when there is nothing in flight (idle exit)", async () => {
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("sx", bus.listen);
    await Promise.resolve();

    const before = store.getSnapshot().state;
    store.injectExit({ code: 0, signal: null });
    // State object is reference-equal — no spurious React re-render work.
    expect(store.getSnapshot().state).toBe(before);
    expect(store.getSnapshot().exit).toEqual({ code: 0, signal: null });
  });
});
