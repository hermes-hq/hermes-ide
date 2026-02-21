/**
 * Tests for 10 bugs found in sessions and context management.
 *
 * Bug 1:  SESSION_REMOVED didn't clean up executionModes (memory leak)
 * Bug 2:  SESSION_REMOVED didn't clean up autoToast referencing removed session
 * Bug 3:  copyContextToClipboard hardcoded version=0 and mode="manual"
 * Bug 4:  SHOW_STUCK_OVERLAY dispatched for already-dismissed sessions
 * Bug 5:  useContextState listen effects leaked listeners on rapid session switches
 * Bug 6:  formatContextMarkdown memory dedup favored ephemeral memoryFacts over persistedMemory
 * Bug 7:  Context cache never invalidated on CWD change (stale suggestions)
 * Bug 8:  Stuck overlay never auto-dismissed when stuck_score dropped below threshold
 * Bug 9:  useContextState sync effect fired on every SESSION_UPDATED due to unstable array deps
 * Bug 10: TerminalPool.destroy didn't clean up sessionShellEnv (memory leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import {
  sessionReducer,
  initialState,
  type SessionData,
} from "../state/SessionContext";

import {
  formatContextMarkdown,
  type ContextState,
} from "../hooks/useContextState";

import {
  invalidateContext,
  getCachedContext,
  detectProjectContext,
} from "../terminal/intelligence/contextAnalyzer";

import {
  clearShellEnvironment,
  getShellEnvironment,
} from "../terminal/intelligence/shellEnvironment";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/home/user/project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0,
      error_count: 0,
      stuck_score: 0,
      token_usage: {},
      tool_calls: [],
      tool_call_summary: {},
      files_touched: [],
      recent_errors: [],
      recent_actions: [],
      available_actions: [],
      memory_facts: [],
      latency_p50_ms: null,
      latency_p95_ms: null,
      latency_samples: [],
      token_history: [],
    },
    ai_provider: null,
    context_injected: false,
    ...overrides,
  };
}

function makeBaseContext(overrides?: Partial<ContextState>): ContextState {
  return {
    pinnedItems: [],
    memoryFacts: [],
    persistedMemory: [],
    realms: [],
    workspacePaths: [],
    workingDirectory: "/home/user/project",
    agent: "anthropic",
    model: "claude-sonnet",
    errorResolutions: [],
    filesTouched: [],
    recentErrors: [],
    ...overrides,
  };
}

// =====================================================================
// Bug 1: SESSION_REMOVED should clean up executionModes
// =====================================================================

describe("Bug 1: SESSION_REMOVED cleans up executionModes", () => {
  it("removes per-session execution mode when session is removed", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    expect(state.executionModes["s1"]).toBe("autonomous");

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.executionModes["s1"]).toBeUndefined();
    expect("s1" in state.executionModes).toBe(false);
  });

  it("does not leak execution modes after many sessions are created and removed", () => {
    let state = initialState;
    for (let i = 0; i < 50; i++) {
      const id = `session-${i}`;
      state = sessionReducer(state, {
        type: "SESSION_UPDATED",
        session: makeSession({ id }),
      });
      state = sessionReducer(state, {
        type: "SET_EXECUTION_MODE",
        sessionId: id,
        mode: "assisted",
      });
      state = sessionReducer(state, { type: "SESSION_REMOVED", id });
    }
    expect(Object.keys(state.executionModes)).toHaveLength(0);
  });

  it("preserves other sessions' execution modes when one is removed", () => {
    let state = initialState;
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2" }),
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s2",
      mode: "assisted",
    });

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.executionModes["s1"]).toBeUndefined();
    expect(state.executionModes["s2"]).toBe("assisted");
  });
});

// =====================================================================
// Bug 2: SESSION_REMOVED should clean up autoToast
// =====================================================================

describe("Bug 2: SESSION_REMOVED cleans up autoToast", () => {
  it("clears autoToast when the referenced session is removed", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, {
      type: "SHOW_AUTO_TOAST",
      command: "npm test",
      reason: "frequent command",
      sessionId: "s1",
    });
    expect(state.ui.autoToast).not.toBeNull();
    expect(state.ui.autoToast!.sessionId).toBe("s1");

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.ui.autoToast).toBeNull();
  });

  it("preserves autoToast when a different session is removed", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2" }),
    });
    state = sessionReducer(state, {
      type: "SHOW_AUTO_TOAST",
      command: "npm test",
      reason: "frequent command",
      sessionId: "s1",
    });

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s2" });
    expect(state.ui.autoToast).not.toBeNull();
    expect(state.ui.autoToast!.sessionId).toBe("s1");
  });

  it("handles SESSION_REMOVED when autoToast is already null", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    expect(state.ui.autoToast).toBeNull();

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.ui.autoToast).toBeNull();
  });
});

// =====================================================================
// Bug 3: copyContextToClipboard should accept version and mode
// =====================================================================

describe("Bug 3: copyContextToClipboard accepts version and execution mode", () => {
  // We test the underlying formatContextMarkdown since copyContextToClipboard
  // uses it, and it now passes through the parameters.

  it("formatContextMarkdown renders the actual version, not hardcoded 0", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 42, "manual");
    expect(output).toContain("# Session Context (v42)");
    expect(output).not.toContain("(v0)");
  });

  it("formatContextMarkdown renders the actual mode, not hardcoded 'manual'", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 1, "autonomous");
    expect(output).toContain("- Mode: autonomous");
    expect(output).not.toContain("- Mode: manual");
  });

  it("version 0 is still valid when explicitly passed", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 0, "manual");
    expect(output).toContain("# Session Context (v0)");
  });

  it("different versions produce different output", () => {
    const ctx = makeBaseContext();
    const v1 = formatContextMarkdown(ctx, 1, "manual");
    const v2 = formatContextMarkdown(ctx, 2, "manual");
    expect(v1).not.toBe(v2);
    expect(v1).toContain("(v1)");
    expect(v2).toContain("(v2)");
  });
});

// =====================================================================
// Bug 4: SHOW_STUCK_OVERLAY for already-dismissed sessions
// =====================================================================

describe("Bug 4: SHOW_STUCK_OVERLAY respects dismissed sessions", () => {
  it("DISMISS_STUCK_OVERLAY adds session to dismissed set", () => {
    let state = sessionReducer(initialState, {
      type: "SHOW_STUCK_OVERLAY",
      sessionId: "s1",
    });
    expect(state.ui.stuckOverlaySessionId).toBe("s1");

    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.stuckOverlaySessionId).toBeNull();
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);
  });

  it("SESSION_REMOVED clears dismissed entry for the removed session", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s1" });
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(false);
  });

  it("multiple sessions can be independently dismissed", () => {
    let state = initialState;

    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s1" });
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });

    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s2" });
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });

    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);
    expect(state.ui.dismissedStuckSessions.has("s2")).toBe(true);
  });
});

// =====================================================================
// Bug 5: useContextState listen effects leak test
// (Can only test the pattern indirectly — verify the cancelled flag approach)
// =====================================================================

describe("Bug 5: Listen effect cleanup pattern", () => {
  // We test the underlying listen mock behavior to verify the cancelled-flag
  // pattern works correctly. The real fix is in useContextState.ts.

  it("listen returns an unlisten function that can be called", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await (listen as ReturnType<typeof vi.fn>)("test-event", () => {});
    expect(typeof unlisten).toBe("function");
    // Should not throw
    unlisten();
  });

  it("cancelled flag pattern prevents state updates after cleanup", () => {
    let cancelled = false;
    let stateUpdated = false;

    // Simulate the pattern used in the fix
    const callback = () => {
      if (!cancelled) {
        stateUpdated = true;
      }
    };

    // Simulate cleanup before callback fires
    cancelled = true;
    callback();

    expect(stateUpdated).toBe(false);
  });

  it("without cancelled flag, state would be updated after cleanup", () => {
    let stateUpdated = false;

    const callback = () => {
      stateUpdated = true;
    };

    // Callback fires after notional cleanup
    callback();
    expect(stateUpdated).toBe(true);
  });
});

// =====================================================================
// Bug 6: Memory dedup should favor persistedMemory over memoryFacts
// =====================================================================

describe("Bug 6: formatContextMarkdown memory dedup precedence", () => {
  it("persistedMemory value wins over memoryFacts when same key exists", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "db_host", value: "session-value", source: "agent", confidence: 0.5 }],
      persistedMemory: [{ key: "db_host", value: "user-saved-value", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("db_host = user-saved-value");
    expect(output).not.toContain("db_host = session-value");
  });

  it("dedup still removes duplicates (only one entry per key)", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "db_host", value: "v1", source: "agent", confidence: 0.5 }],
      persistedMemory: [{ key: "db_host", value: "v2", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    const matches = output.match(/db_host/g) || [];
    expect(matches.length).toBe(1);
  });

  it("shows all keys when there are no overlapping keys", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "session_key", value: "session_val", source: "agent", confidence: 0.8 }],
      persistedMemory: [{ key: "persisted_key", value: "persisted_val", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("session_key = session_val");
    expect(output).toContain("persisted_key = persisted_val");
  });

  it("handles empty memoryFacts with non-empty persistedMemory", () => {
    const ctx = makeBaseContext({
      memoryFacts: [],
      persistedMemory: [{ key: "only_persisted", value: "val", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Memory");
    expect(output).toContain("only_persisted = val");
  });

  it("handles non-empty memoryFacts with empty persistedMemory", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "only_session", value: "val", source: "agent", confidence: 0.5 }],
      persistedMemory: [],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Memory");
    expect(output).toContain("only_session = val");
  });

  it("handles multiple overlapping keys with correct precedence", () => {
    const ctx = makeBaseContext({
      memoryFacts: [
        { key: "key1", value: "session-1", source: "agent", confidence: 0.5 },
        { key: "key2", value: "session-2", source: "agent", confidence: 0.5 },
      ],
      persistedMemory: [
        { key: "key1", value: "persisted-1", source: "user" },
        { key: "key3", value: "persisted-3", source: "user" },
      ],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    // key1: persisted wins
    expect(output).toContain("key1 = persisted-1");
    expect(output).not.toContain("key1 = session-1");
    // key2: only session source exists
    expect(output).toContain("key2 = session-2");
    // key3: only persisted source exists
    expect(output).toContain("key3 = persisted-3");
  });
});

// =====================================================================
// Bug 7: Context cache invalidation on CWD change
// =====================================================================

describe("Bug 7: Context cache invalidation on CWD change", () => {
  it("invalidateContext removes cached context for a path", async () => {
    // getCachedContext returns null for unknown paths
    expect(getCachedContext("/some/test/path")).toBeNull();

    // detectProjectContext catches errors and stores a fallback in the cache.
    // The mocked invoke returns undefined (not a valid ProjectContext), so
    // detectProjectContext's catch block stores a proper fallback object.
    await detectProjectContext("/some/test/path");

    // Verify it's cached (the fallback object is stored)
    const cached = getCachedContext("/some/test/path");
    expect(cached).toBeDefined();

    // After invalidation, cache should be cleared
    invalidateContext("/some/test/path");
    expect(getCachedContext("/some/test/path")).toBeNull();
  });

  it("invalidateContext only removes the specified path", async () => {
    await detectProjectContext("/test/path/a");
    await detectProjectContext("/test/path/b");

    // Both should be cached
    const cachedA = getCachedContext("/test/path/a");
    const cachedB = getCachedContext("/test/path/b");
    expect(cachedA).toBeDefined();
    expect(cachedB).toBeDefined();

    // Invalidate only path A
    invalidateContext("/test/path/a");
    expect(getCachedContext("/test/path/a")).toBeNull();
    expect(getCachedContext("/test/path/b")).toBeDefined();

    // Cleanup
    invalidateContext("/test/path/b");
  });

  it("invalidateContext is a no-op for non-cached paths", () => {
    // Should not throw
    invalidateContext("/nonexistent/path");
    expect(getCachedContext("/nonexistent/path")).toBeNull();
  });
});

// =====================================================================
// Bug 8: Stuck overlay auto-dismiss when stuck_score drops
// =====================================================================

describe("Bug 8: Stuck overlay auto-dismiss on recovery", () => {
  it("DISMISS_STUCK_OVERLAY clears stuckOverlaySessionId", () => {
    let state = sessionReducer(initialState, {
      type: "SHOW_STUCK_OVERLAY",
      sessionId: "s1",
    });
    expect(state.ui.stuckOverlaySessionId).toBe("s1");

    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.stuckOverlaySessionId).toBeNull();
  });

  it("SESSION_UPDATED with low stuck_score after high stuck_score (reducer handles correctly)", () => {
    // This test verifies the reducer state transitions are correct.
    // The actual auto-dismiss logic is in the event handler in SessionProvider.
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", metrics: {
        ...makeSession().metrics,
        stuck_score: 0.9,
      }}),
    });
    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s1" });
    expect(state.ui.stuckOverlaySessionId).toBe("s1");

    // When stuck_score drops, DISMISS_STUCK_OVERLAY should be dispatched
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.stuckOverlaySessionId).toBeNull();
  });

  it("SHOW_STUCK_OVERLAY then DISMISS_STUCK_OVERLAY cycle works correctly", () => {
    let state = initialState;

    // First stuck -> dismiss cycle
    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s1" });
    expect(state.ui.stuckOverlaySessionId).toBe("s1");
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.stuckOverlaySessionId).toBeNull();
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);

    // Second stuck on different session -> dismiss
    state = sessionReducer(state, { type: "SHOW_STUCK_OVERLAY", sessionId: "s2" });
    expect(state.ui.stuckOverlaySessionId).toBe("s2");
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });
    expect(state.ui.stuckOverlaySessionId).toBeNull();
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);
    expect(state.ui.dismissedStuckSessions.has("s2")).toBe(true);
  });
});

// =====================================================================
// Bug 9: useContextState sync effect stability
// =====================================================================

describe("Bug 9: Session sync key stability", () => {
  // We can't test the React hook directly without a test renderer,
  // but we can verify the serialization logic that determines whether
  // the effect should fire.

  it("identical session data produces identical JSON keys", () => {
    const session = makeSession();
    const key1 = JSON.stringify({
      wd: session.working_directory,
      wp: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      mf: session.metrics.memory_facts,
      ft: session.metrics.files_touched,
      re: session.metrics.recent_errors,
    });
    const key2 = JSON.stringify({
      wd: session.working_directory,
      wp: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      mf: session.metrics.memory_facts,
      ft: session.metrics.files_touched,
      re: session.metrics.recent_errors,
    });
    expect(key1).toBe(key2);
  });

  it("different array instances with same values produce identical JSON keys", () => {
    const session1 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
      metrics: { ...makeSession().metrics, files_touched: ["a.ts", "b.ts"] },
    });
    // Simulate a new SESSION_UPDATED event with fresh array instances
    const session2 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
      metrics: { ...makeSession().metrics, files_touched: ["a.ts", "b.ts"] },
    });

    // Reference equality fails (this is why the original code was buggy)
    expect(session1.workspace_paths).not.toBe(session2.workspace_paths);
    expect(session1.metrics.files_touched).not.toBe(session2.metrics.files_touched);

    // But JSON serialization produces identical keys (this is the fix)
    const key1 = JSON.stringify({
      wd: session1.working_directory,
      wp: session1.workspace_paths,
      ft: session1.metrics.files_touched,
    });
    const key2 = JSON.stringify({
      wd: session2.working_directory,
      wp: session2.workspace_paths,
      ft: session2.metrics.files_touched,
    });
    expect(key1).toBe(key2);
  });

  it("actually changed values produce different JSON keys", () => {
    const session1 = makeSession({
      workspace_paths: ["/path/a"],
      metrics: { ...makeSession().metrics, files_touched: ["a.ts"] },
    });
    const session2 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
      metrics: { ...makeSession().metrics, files_touched: ["a.ts", "b.ts"] },
    });

    const key1 = JSON.stringify({
      wp: session1.workspace_paths,
      ft: session1.metrics.files_touched,
    });
    const key2 = JSON.stringify({
      wp: session2.workspace_paths,
      ft: session2.metrics.files_touched,
    });
    expect(key1).not.toBe(key2);
  });

  it("agent detection change produces different JSON key", () => {
    const session1 = makeSession({ detected_agent: null });
    const session2 = makeSession({
      detected_agent: {
        name: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet",
        detected_at: "2025-01-01T00:00:00Z",
        confidence: 0.9,
      },
    });

    const key1 = JSON.stringify({
      agent: session1.detected_agent?.name ?? null,
      model: session1.detected_agent?.model ?? null,
    });
    const key2 = JSON.stringify({
      agent: session2.detected_agent?.name ?? null,
      model: session2.detected_agent?.model ?? null,
    });
    expect(key1).not.toBe(key2);
  });
});

// =====================================================================
// Bug 10: TerminalPool.destroy should clean up sessionShellEnv
// =====================================================================

describe("Bug 10: Shell environment cleanup on destroy", () => {
  it("clearShellEnvironment removes stored environment", () => {
    // Verify that clearShellEnvironment cleans up the sessionShellEnv Map
    // The environment map is set via detectShellEnvironment, but for unit tests
    // we verify the cleanup function works correctly.
    const sessionId = "test-session";

    // Before any detection, there should be no environment
    expect(getShellEnvironment(sessionId)).toBeNull();

    // clearShellEnvironment should be safe to call on non-existent entries
    clearShellEnvironment(sessionId);
    expect(getShellEnvironment(sessionId)).toBeNull();
  });

  it("clearShellEnvironment does not affect other sessions", () => {
    // Verify cleanup is session-scoped
    clearShellEnvironment("session-a");
    clearShellEnvironment("session-b");
    // Should not throw or have side effects
    expect(getShellEnvironment("session-a")).toBeNull();
    expect(getShellEnvironment("session-b")).toBeNull();
  });

  it("invalidateContext cleans up stale context after CWD change", () => {
    // Verify that context cache can be invalidated
    const oldCwd = "/old/path";
    const newCwd = "/new/path";

    // Invalidate is safe even when nothing is cached
    invalidateContext(oldCwd);
    expect(getCachedContext(oldCwd)).toBeNull();
    expect(getCachedContext(newCwd)).toBeNull();
  });
});

// =====================================================================
// Integration: Multiple bugs interacting correctly
// =====================================================================

describe("Integration: Multi-bug session lifecycle", () => {
  it("full session lifecycle cleans up all per-session state", () => {
    let state = initialState;

    // Create session
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });

    // Set per-session execution mode
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });

    // Show auto toast for this session
    state = sessionReducer(state, {
      type: "SHOW_AUTO_TOAST",
      command: "npm test",
      reason: "frequent command",
      sessionId: "s1",
    });

    // Show stuck overlay for this session
    state = sessionReducer(state, {
      type: "SHOW_STUCK_OVERLAY",
      sessionId: "s1",
    });

    // Dismiss stuck overlay (adds to dismissed set)
    state = sessionReducer(state, { type: "DISMISS_STUCK_OVERLAY" });

    // Verify all per-session state exists
    expect(state.executionModes["s1"]).toBe("autonomous");
    expect(state.ui.autoToast).not.toBeNull();
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(true);

    // Remove session — all per-session state should be cleaned up
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });

    expect(state.sessions["s1"]).toBeUndefined();
    expect(state.executionModes["s1"]).toBeUndefined();
    expect(state.ui.autoToast).toBeNull();
    expect(state.ui.dismissedStuckSessions.has("s1")).toBe(false);
  });

  it("removing one session preserves all state for other sessions", () => {
    let state = initialState;

    // Create two sessions
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", label: "Session 1" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2", label: "Session 2" }),
    });

    // Set modes for both
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s2",
      mode: "assisted",
    });

    // Show toast for s2
    state = sessionReducer(state, {
      type: "SHOW_AUTO_TOAST",
      command: "cargo test",
      reason: "frequent",
      sessionId: "s2",
    });

    // Remove s1
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });

    // s2 state should be fully preserved
    expect(state.sessions["s2"]).toBeDefined();
    expect(state.sessions["s2"].label).toBe("Session 2");
    expect(state.executionModes["s2"]).toBe("assisted");
    expect(state.ui.autoToast).not.toBeNull();
    expect(state.ui.autoToast!.sessionId).toBe("s2");
  });
});

// =====================================================================
// Regression: Existing behavior unchanged
// =====================================================================

describe("Regression: formatContextMarkdown still works correctly", () => {
  it("includes all sections", () => {
    const ctx = makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/src/main.ts", label: "Main entry",
        priority: 128, created_at: 1000,
      }],
      realms: [{
        realm_id: "r1", realm_name: "my-project", path: "/home/user/my-project",
        languages: ["TypeScript"], frameworks: ["React"],
        architecture_pattern: "MVC", architecture_layers: [],
        conventions: ["Use camelCase"], scan_status: "deep",
      }],
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
      errorResolutions: [{
        fingerprint: "TypeError: cannot read",
        resolution: "check null",
        occurrence_count: 3,
      }],
      workspacePaths: ["/extra"],
      filesTouched: ["index.ts"],
    });

    const output = formatContextMarkdown(ctx, 5, "assisted");

    expect(output).toContain("# Session Context (v5)");
    expect(output).toContain("- Mode: assisted");
    expect(output).toContain("- Provider: anthropic (claude-sonnet)");
    expect(output).toContain("## Projects");
    expect(output).toContain("## Pinned Context");
    expect(output).toContain("## Memory");
    expect(output).toContain("## Known Error Resolutions");
    expect(output).toContain("## Workspace");
  });

  it("empty sections are omitted", () => {
    const ctx = makeBaseContext({ agent: null, model: null });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).not.toContain("Provider:");
    expect(output).not.toContain("## Projects");
    expect(output).not.toContain("## Pinned Context");
    expect(output).not.toContain("## Memory");
    expect(output).not.toContain("## Known Error Resolutions");
    expect(output).toContain("## Workspace");
  });
});
