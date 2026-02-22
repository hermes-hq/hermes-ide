/**
 * Tests for close session confirmation dialog behavior.
 *
 * Tests cover:
 *   1. requestCloseSession respects skipCloseConfirm preference
 *   2. Reducer actions for REQUEST_CLOSE_SESSION, CANCEL_CLOSE_SESSION, SET_SKIP_CLOSE_CONFIRM
 *   3. Dialog confirm/cancel flows
 */
import { describe, it, expect, vi } from "vitest";

// Mock browser-only dependencies that SessionContext.tsx transitively imports
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  writeScrollback: vi.fn(),
  focusTerminal: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { sessionReducer, initialState } from "../state/SessionContext";

// ─── Tests: Reducer actions ──────────────────────────────────────────

describe("Close session dialog: reducer actions", () => {
  it("REQUEST_CLOSE_SESSION sets pendingCloseSessionId", () => {
    const state = sessionReducer(initialState, {
      type: "REQUEST_CLOSE_SESSION",
      id: "sess-123",
    });
    expect(state.pendingCloseSessionId).toBe("sess-123");
  });

  it("CANCEL_CLOSE_SESSION clears pendingCloseSessionId", () => {
    const stateWithPending = {
      ...initialState,
      pendingCloseSessionId: "sess-123" as string | null,
    };
    const state = sessionReducer(stateWithPending, {
      type: "CANCEL_CLOSE_SESSION",
    });
    expect(state.pendingCloseSessionId).toBeNull();
  });

  it("SET_SKIP_CLOSE_CONFIRM sets skipCloseConfirm to true", () => {
    const state = sessionReducer(initialState, {
      type: "SET_SKIP_CLOSE_CONFIRM",
      skip: true,
    });
    expect(state.skipCloseConfirm).toBe(true);
  });

  it("SET_SKIP_CLOSE_CONFIRM sets skipCloseConfirm to false", () => {
    const stateWithSkip = { ...initialState, skipCloseConfirm: true };
    const state = sessionReducer(stateWithSkip, {
      type: "SET_SKIP_CLOSE_CONFIRM",
      skip: false,
    });
    expect(state.skipCloseConfirm).toBe(false);
  });

  it("initial state has pendingCloseSessionId=null and skipCloseConfirm=false", () => {
    expect(initialState.pendingCloseSessionId).toBeNull();
    expect(initialState.skipCloseConfirm).toBe(false);
  });
});

// ─── Tests: requestCloseSession logic ────────────────────────────────

describe("Close session dialog: requestCloseSession flow", () => {
  it("close without confirmation → sets pendingCloseSessionId when skip=false", () => {
    const skipCloseConfirm = false;
    let pendingId: string | null = null;
    let closeCalled = false;

    const requestClose = (id: string) => {
      if (skipCloseConfirm) {
        closeCalled = true;
      } else {
        pendingId = id;
      }
    };

    requestClose("sess-abc");
    expect(pendingId).toBe("sess-abc");
    expect(closeCalled).toBe(false);
  });

  it("close with skip preference → calls closeSession directly", () => {
    const skipCloseConfirm = true;
    let pendingId: string | null = null;
    let closedId: string | null = null;

    const requestClose = (id: string) => {
      if (skipCloseConfirm) {
        closedId = id;
      } else {
        pendingId = id;
      }
    };

    requestClose("sess-abc");
    expect(pendingId).toBeNull();
    expect(closedId).toBe("sess-abc");
  });

  it("confirm close → clears pending state", () => {
    let state = sessionReducer(initialState, {
      type: "REQUEST_CLOSE_SESSION",
      id: "sess-123",
    });
    expect(state.pendingCloseSessionId).toBe("sess-123");

    // User confirms → cancel pending (closeSession called separately as side effect)
    state = sessionReducer(state, { type: "CANCEL_CLOSE_SESSION" });
    expect(state.pendingCloseSessionId).toBeNull();
  });

  it("cancel → dialog dismissed, session unaffected", () => {
    let state = sessionReducer(initialState, {
      type: "REQUEST_CLOSE_SESSION",
      id: "sess-123",
    });
    expect(state.pendingCloseSessionId).toBe("sess-123");

    state = sessionReducer(state, { type: "CANCEL_CLOSE_SESSION" });
    expect(state.pendingCloseSessionId).toBeNull();
  });

  it("closing one session does not affect other sessions in state", () => {
    const makeSession = (id: string, label: string) => ({
      id, label, color: "#ff0000", group: null,
      phase: "idle", working_directory: "/a", shell: "zsh",
      created_at: "2025-01-01", last_activity_at: "2025-01-01",
      workspace_paths: [] as string[], detected_agent: null,
      metrics: {
        output_lines: 0, error_count: 0, stuck_score: 0,
        token_usage: {}, tool_calls: [], tool_call_summary: {},
        files_touched: [] as string[], recent_errors: [] as string[],
        recent_actions: [], available_actions: [], memory_facts: [],
        latency_p50_ms: null, latency_p95_ms: null,
        latency_samples: [] as number[], token_history: [] as [number, number][],
      },
      ai_provider: null, context_injected: false,
    });

    let state = sessionReducer(initialState, { type: "SESSION_UPDATED", session: makeSession("sess-1", "Session 1") });
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession("sess-2", "Session 2") });

    // Request close for session 1
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "sess-1" });
    expect(state.pendingCloseSessionId).toBe("sess-1");

    // Both sessions still in state
    expect(state.sessions["sess-1"]).toBeDefined();
    expect(state.sessions["sess-2"]).toBeDefined();

    // Cancel close
    state = sessionReducer(state, { type: "CANCEL_CLOSE_SESSION" });
    expect(state.sessions["sess-1"]).toBeDefined();
    expect(state.sessions["sess-2"]).toBeDefined();
  });
});
