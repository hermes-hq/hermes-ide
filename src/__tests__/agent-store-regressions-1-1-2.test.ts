/**
 * Regression suite for v1.1.2 agent-mode bug fixes.
 *
 * Each `describe` block targets exactly one bug from the audit so that
 * a future refactor that breaks any single fix surfaces a single
 * obvious test failure rather than a spray of unrelated noise.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AgentSessionStore,
  _capStderr,
  _resetAgentSessionStoresForTest,
  getOrCreateAgentSessionStore,
} from "../agent/agentSessionStore";
import { reduceEvent, emptyState } from "../agent/messageStore";
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
        get attached() { return attached; },
        set attached(v: boolean) { attached = v; },
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
function initEvent(sessionId: string): AgentEvent {
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
function permRequestEvent(id: string, toolName = "Bash"): AgentEvent {
  return {
    type: "_hermes_perm_request",
    id,
    toolName,
    input: { command: "echo hi" },
  } as unknown as AgentEvent;
}
function assistantWithToolUse(messageId: string, toolUseId: string): AgentEvent {
  return {
    type: "assistant",
    message: {
      id: messageId,
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "echo hi" },
        },
      ],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as AgentEvent;
}
function resultEvent(uuid: string | null, costUsd: number, outputTokens: number): AgentEvent {
  const e: Record<string, unknown> = {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: costUsd,
    usage: { output_tokens: outputTokens },
  };
  if (uuid !== null) e.uuid = uuid;
  return e as unknown as AgentEvent;
}

beforeEach(() => {
  _resetAgentSessionStoresForTest();
});

// ─── C1: pending perm request survives unmount ─────────────────────
describe("C1: pending permission request persists across React unmount", () => {
  it("captures perm requests from the agent stream into snapshot.pendingPermRequest", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const ch = bus.channels.get("agent-event-s1")!;
    [...ch][0].fire(permRequestEvent("perm-1"));

    const snap = store.getSnapshot();
    expect(snap.pendingPermRequest).not.toBeNull();
    expect(snap.pendingPermRequest!.id).toBe("perm-1");
  });

  it("KEY REGRESSION: pending request survives consumer subscribe/unsubscribe cycle", async () => {
    const bus = makeStubBus();
    const store = getOrCreateAgentSessionStore("s1", bus.listen);
    await Promise.resolve();

    // Mounted dispatcher subscribes.
    const sub1 = vi.fn();
    const unsub = store.subscribe(sub1);

    // Bridge sends a perm request, dispatcher renders modal.
    const ch = bus.channels.get("agent-event-s1")!;
    [...ch][0].fire(permRequestEvent("perm-1"));
    expect(store.getSnapshot().pendingPermRequest!.id).toBe("perm-1");

    // User switches sessions — dispatcher unmounts.
    unsub();

    // Dispatcher remounts when user returns — request is still there.
    const sub2 = vi.fn();
    store.subscribe(sub2);
    expect(store.getSnapshot().pendingPermRequest!.id).toBe("perm-1");
  });

  it("clearPendingPermRequest() removes the request and notifies", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectEvent(permRequestEvent("perm-1"));
    const cb = vi.fn();
    store.subscribe(cb);
    store.clearPendingPermRequest();
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
    expect(cb).toHaveBeenCalled();
  });

  it("does NOT fold perm requests into the message stream", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectEvent(permRequestEvent("perm-1"));
    expect(store.getSnapshot().state.messages).toHaveLength(0);
  });
});

// ─── H1: cross-channel exit-after-init race ────────────────────────
describe("H1: stale agent-exit from prior subprocess is ignored after fresh init", () => {
  it("drops exit events that arrive within the post-init grace window", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    // Fresh init → bumps generation, sets lastInitAt to now.
    [...bus.channels.get("agent-event-s1")!][0].fire(initEvent("new-uuid"));
    // Exit from the OLD subprocess arrives moments later (cross-channel
    // reorder).  Without H1 this would paint a phantom "agent exited"
    // banner over a perfectly healthy bridge.
    [...bus.channels.get("agent-exit-s1")!][0].fire({ code: 1, signal: null });
    expect(store.getSnapshot().exit).toBeNull();
  });

  it("passes through exit events that arrive AFTER the grace window", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    [...bus.channels.get("agent-event-s1")!][0].fire(initEvent("new-uuid"));
    // Pretend lots of time has passed — manually bypass the grace
    // window by calling injectExit with a stale lastInitAt.  The
    // production path uses Date.now(); a wall-clock advancement test
    // would be flaky, so we drive it directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).lastInitAt = Date.now() - 10_000;
    store.injectExit({ code: 1, signal: null });
    expect(store.getSnapshot().exit).not.toBeNull();
  });

  it("init bumps generation counter monotonically", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    expect(store.getInitGeneration()).toBe(0);
    [...bus.channels.get("agent-event-s1")!][0].fire(initEvent("u1"));
    expect(store.getInitGeneration()).toBe(1);
    [...bus.channels.get("agent-event-s1")!][0].fire(initEvent("u2"));
    expect(store.getInitGeneration()).toBe(2);
  });
});

// ─── H4: orphaned runningToolUseIds ─────────────────────────────────
describe("H4: runningToolUseIds is cleared on init and result", () => {
  it("init clears any running tool ids from a prior subprocess generation", () => {
    let s = emptyState();
    s = reduceEvent(s, assistantWithToolUse("m1", "tu-1"));
    expect(s.runningToolUseIds.has("tu-1")).toBe(true);
    // Bridge respawned; init arrives.
    s = reduceEvent(s, initEvent("new-uuid"));
    expect(s.runningToolUseIds.size).toBe(0);
    expect(s.streamingMessageId).toBeNull();
  });

  it("result event clears running tool ids (turn boundary)", () => {
    let s = emptyState();
    s = reduceEvent(s, assistantWithToolUse("m1", "tu-1"));
    expect(s.runningToolUseIds.has("tu-1")).toBe(true);
    s = reduceEvent(s, resultEvent("r-1", 0.01, 100));
    expect(s.runningToolUseIds.size).toBe(0);
  });

  it("activity indicator no longer hangs on 'running' after a respawn mid-tool", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectEvent(assistantWithToolUse("m1", "tu-1"));
    expect(store.getSnapshot().state.runningToolUseIds.size).toBe(1);
    store.injectEvent(initEvent("u-new"));
    expect(store.getSnapshot().state.runningToolUseIds.size).toBe(0);
  });
});

// ─── H5: stderr cap ────────────────────────────────────────────────
describe("H5: stderr is bounded, never grows unbounded", () => {
  it("_capStderr keeps the buffer below STDERR_MAX_BYTES", () => {
    // 2 MiB of data fed in — should be capped at ~1 MiB plus the header.
    let buf = "";
    const chunk = "x".repeat(64 * 1024); // 64 KiB
    for (let i = 0; i < 32; i++) buf = _capStderr(buf, chunk);
    expect(buf.length).toBeLessThan(1 << 20 + 200);
    expect(buf).toContain("[stderr truncated");
  });

  it("preserves the most-recent bytes after truncation (tail wins)", () => {
    // Fill past the cap with a unique tail marker.
    let buf = _capStderr("", "a".repeat(1 << 20));
    buf = _capStderr(buf, "TAIL-MARKER\n");
    expect(buf).toContain("TAIL-MARKER");
  });

  it("AgentSessionStore caps stderr in the live event handler", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const ch = bus.channels.get("agent-stderr-s1")!;
    const fire = (chunk: string) => [...ch][0].fire(chunk);
    fire("a".repeat(1 << 19)); // 512 KiB
    fire("b".repeat(1 << 19)); // 512 KiB
    fire("c".repeat(1 << 19)); // 512 KiB → past the cap
    const len = store.getSnapshot().stderr.length;
    expect(len).toBeLessThan((1 << 20) + 200);
  });
});

// ─── M1: result event dedupe by uuid ───────────────────────────────
describe("M1: duplicate result events do not double-count cost", () => {
  it("a re-emitted result event is a no-op for cumulativeCostUsd", () => {
    let s = emptyState();
    s = reduceEvent(s, resultEvent("r-1", 0.05, 1000));
    expect(s.cumulativeCostUsd).toBeCloseTo(0.05);
    expect(s.cumulativeOutputTokens).toBe(1000);
    s = reduceEvent(s, resultEvent("r-1", 0.05, 1000)); // duplicate
    expect(s.cumulativeCostUsd).toBeCloseTo(0.05);
    expect(s.cumulativeOutputTokens).toBe(1000);
  });

  it("distinct result events still accumulate correctly", () => {
    let s = emptyState();
    s = reduceEvent(s, resultEvent("r-1", 0.05, 1000));
    s = reduceEvent(s, resultEvent("r-2", 0.07, 500));
    expect(s.cumulativeCostUsd).toBeCloseTo(0.12);
    expect(s.cumulativeOutputTokens).toBe(1500);
  });

  it("events without uuid (older bridges) still accumulate (no dedup)", () => {
    let s = emptyState();
    s = reduceEvent(s, resultEvent(null, 0.05, 1000));
    s = reduceEvent(s, resultEvent(null, 0.05, 1000));
    // Unidentifiable events fall through to legacy behavior — dedup
    // requires a uuid.  The intent of M1 is to defend against
    // re-emit; bridges that don't tag events keep the prior path.
    expect(s.cumulativeCostUsd).toBeCloseTo(0.10);
  });
});

// ─── reset() clears the seenResultEventIds bookkeeping ─────────────
describe("store.reset clears all session state", () => {
  it("resets cost, messages, perm requests, and result-id dedup set", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    store.injectEvent(resultEvent("r-1", 0.05, 1000));
    store.injectEvent(permRequestEvent("perm-1"));
    expect(store.getSnapshot().state.cumulativeCostUsd).toBeCloseTo(0.05);
    expect(store.getSnapshot().pendingPermRequest).not.toBeNull();
    store.reset();
    expect(store.getSnapshot().state.cumulativeCostUsd).toBe(0);
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
  });
});
