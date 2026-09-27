// @vitest-environment jsdom
/**
 * N10 — `useBusyAgentSessionCount` counts agent-mode sessions that are
 * actually working (streaming a reply / running a tool), reading the same
 * real per-session store `AgentSessionView` renders from. Terminal-mode and
 * destroyed sessions never count; a session left in the background (its pane
 * unmounted) still counts while it is genuinely mid-turn.
 *
 * Drives the REAL `AgentSessionStore` (via `injectEvent`, exactly like
 * `agent-session-store.test.ts`) rather than re-implementing its state
 * machine, so this exercises the real `selectWorkingState` predicate too.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentEvent } from "../agent/types";
import type { SessionData } from "../types/session";

// ── Stub Tauri event bus (same shape as agent-session-store.test.ts) ──
type StubListenerHandle = { fire: (payload: unknown) => void };
interface StubBus {
  channels: Map<string, Set<StubListenerHandle>>;
  listen: <T>(name: string, handler: (msg: { payload: T }) => void) => Promise<() => void>;
}
function makeStubBus(): StubBus {
  const channels = new Map<string, Set<StubListenerHandle>>();
  return {
    channels,
    listen: <T,>(name: string, handler: (msg: { payload: T }) => void) => {
      const set = channels.get(name) ?? new Set<StubListenerHandle>();
      const handle: StubListenerHandle = { fire: (p) => handler({ payload: p as T }) };
      set.add(handle);
      channels.set(name, set);
      return Promise.resolve(() => {
        set.delete(handle);
      });
    },
  };
}
const bus = makeStubBus();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (msg: { payload: unknown }) => void) => bus.listen(name, handler),
}));

// ── Controllable session list, read by the hook via useSessionList() ──
let currentSessions: SessionData[] = [];
vi.mock("../state/SessionContext", () => ({
  useSessionList: () => currentSessions,
}));

import { useBusyAgentSessionCount } from "../agent/useBusyAgentSessionCount";
import { getOrCreateAgentSessionStore, _resetAgentSessionStoresForTest } from "../agent/agentSessionStore";

function makeSession(overrides: Partial<SessionData> & { id: string }): SessionData {
  return {
    label: overrides.id,
    description: "",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/tmp/test-project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {},
      tool_calls: [], tool_call_summary: {}, files_touched: [], recent_errors: [],
      recent_actions: [], available_actions: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
    ai_provider: "claude",
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "agent",
    ...overrides,
  };
}

/** Mid-turn: an assistant message that hasn't finished streaming yet. */
function streamingEvent(messageId: string): AgentEvent {
  return {
    type: "assistant",
    message: {
      id: messageId, role: "assistant", model: "m",
      content: [{ type: "text", text: "partial" }],
      stop_reason: null,
    },
    session_id: "s", uuid: `u-${messageId}`,
  } as unknown as AgentEvent;
}

/** Turn finished: same message id, closed with a stop_reason. */
function finishedEvent(messageId: string): AgentEvent {
  return {
    type: "assistant",
    message: {
      id: messageId, role: "assistant", model: "m",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: "s", uuid: `u-${messageId}-done`,
  } as unknown as AgentEvent;
}

describe("useBusyAgentSessionCount", () => {
  beforeEach(() => {
    _resetAgentSessionStoresForTest();
    currentSessions = [];
  });

  it("is 0 when there are no agent sessions", () => {
    currentSessions = [makeSession({ id: "t1", mode: "terminal" })];
    const { result } = renderHook(() => useBusyAgentSessionCount());
    expect(result.current).toBe(0);
  });

  it("counts an agent session as busy once it starts streaming a reply", () => {
    currentSessions = [makeSession({ id: "a1", mode: "agent" })];
    const { result } = renderHook(() => useBusyAgentSessionCount());
    expect(result.current).toBe(0);

    act(() => {
      getOrCreateAgentSessionStore("a1", bus.listen).injectEvent(streamingEvent("m1"));
    });
    expect(result.current).toBe(1);

    act(() => {
      getOrCreateAgentSessionStore("a1", bus.listen).injectEvent(finishedEvent("m1"));
    });
    expect(result.current).toBe(0);
  });

  it("counts a session as busy even while its pane isn't mounted (background store)", () => {
    // No AgentSessionView has necessarily read this store; the hook itself
    // is what creates it (mirrors production: the store outlives remounts).
    currentSessions = [makeSession({ id: "bg1", mode: "agent" })];
    const { result } = renderHook(() => useBusyAgentSessionCount());

    act(() => {
      // Simulate the store already existing from an earlier mount.
      getOrCreateAgentSessionStore("bg1", bus.listen).injectEvent(streamingEvent("m1"));
    });
    expect(result.current).toBe(1);
  });

  it("sums across multiple busy agent sessions", () => {
    currentSessions = [
      makeSession({ id: "a1", mode: "agent" }),
      makeSession({ id: "a2", mode: "agent" }),
      makeSession({ id: "a3", mode: "agent" }),
    ];
    const { result } = renderHook(() => useBusyAgentSessionCount());

    act(() => {
      getOrCreateAgentSessionStore("a1", bus.listen).injectEvent(streamingEvent("m1"));
      getOrCreateAgentSessionStore("a2", bus.listen).injectEvent(streamingEvent("m2"));
    });
    expect(result.current).toBe(2);

    act(() => {
      getOrCreateAgentSessionStore("a1", bus.listen).injectEvent(finishedEvent("m1"));
    });
    expect(result.current).toBe(1);
  });

  it("ignores terminal-mode sessions even if their id collides with agent-store activity", () => {
    currentSessions = [makeSession({ id: "term1", mode: "terminal" })];
    const { result } = renderHook(() => useBusyAgentSessionCount());

    act(() => {
      // Even if something wrote an agent store under this id, a
      // terminal-mode session must never be counted as a busy agent.
      getOrCreateAgentSessionStore("term1", bus.listen).injectEvent(streamingEvent("m1"));
    });
    expect(result.current).toBe(0);
  });

  it("stops counting a destroyed session, even if its store is still 'busy'", () => {
    currentSessions = [makeSession({ id: "a1", mode: "agent" })];
    const { result, rerender } = renderHook(() => useBusyAgentSessionCount());

    act(() => {
      getOrCreateAgentSessionStore("a1", bus.listen).injectEvent(streamingEvent("m1"));
    });
    expect(result.current).toBe(1);

    act(() => {
      currentSessions = [makeSession({ id: "a1", mode: "agent", phase: "destroyed" })];
    });
    rerender();
    expect(result.current).toBe(0);
  });

  it("updates when a new agent session appears and starts working", () => {
    currentSessions = [];
    const { result, rerender } = renderHook(() => useBusyAgentSessionCount());
    expect(result.current).toBe(0);

    act(() => {
      currentSessions = [makeSession({ id: "new1", mode: "agent" })];
    });
    rerender();
    expect(result.current).toBe(0);

    act(() => {
      getOrCreateAgentSessionStore("new1", bus.listen).injectEvent(streamingEvent("m1"));
    });
    expect(result.current).toBe(1);
  });
});
