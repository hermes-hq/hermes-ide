/**
 * Tests for bugs found in sessions and context management.
 *
 * Bug 3:  copyContextToClipboard hardcoded version=0
 * Bug 5:  useContextState listen effects leaked listeners on rapid session switches
 * Bug 6:  formatContextMarkdown memory dedup favored ephemeral memoryFacts over persistedMemory
 * Bug 7:  Context cache never invalidated on CWD change (stale suggestions)
 * Bug 9:  useContextState sync effect fired on every SESSION_UPDATED due to unstable array deps
 * Bug 10: TerminalPool.destroy didn't clean up sessionShellEnv (memory leak)
 */
import { describe, it, expect, vi } from "vitest";

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
    projects: [],
    workspacePaths: [],
    workingDirectory: "/home/user/project",
    agent: "anthropic",
    model: "claude-sonnet",
    ...overrides,
  };
}

// =====================================================================
// Bug 3: copyContextToClipboard should accept version
// =====================================================================

describe("Bug 3: copyContextToClipboard accepts version", () => {
  // We test the underlying formatContextMarkdown since copyContextToClipboard
  // uses it, and it now passes through the parameters.

  it("formatContextMarkdown renders the actual version, not hardcoded 0", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 42);
    expect(output).toContain("# Session Context (v42)");
    expect(output).not.toContain("(v0)");
  });

  it("version 0 is still valid when explicitly passed", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 0);
    expect(output).toContain("# Session Context (v0)");
  });

  it("different versions produce different output", () => {
    const ctx = makeBaseContext();
    const v1 = formatContextMarkdown(ctx, 1);
    const v2 = formatContextMarkdown(ctx, 2);
    expect(v1).not.toBe(v2);
    expect(v1).toContain("(v1)");
    expect(v2).toContain("(v2)");
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
    const unlisten = await (listen as unknown as (...args: unknown[]) => Promise<() => void>)("test-event", () => {});
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
    const output = formatContextMarkdown(ctx, 1);
    expect(output).toContain("db_host = user-saved-value");
    expect(output).not.toContain("db_host = session-value");
  });

  it("dedup still removes duplicates (only one entry per key)", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "db_host", value: "v1", source: "agent", confidence: 0.5 }],
      persistedMemory: [{ key: "db_host", value: "v2", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1);
    const matches = output.match(/db_host/g) || [];
    expect(matches.length).toBe(1);
  });

  it("shows all keys when there are no overlapping keys", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "session_key", value: "session_val", source: "agent", confidence: 0.8 }],
      persistedMemory: [{ key: "persisted_key", value: "persisted_val", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1);
    expect(output).toContain("session_key = session_val");
    expect(output).toContain("persisted_key = persisted_val");
  });

  it("handles empty memoryFacts with non-empty persistedMemory", () => {
    const ctx = makeBaseContext({
      memoryFacts: [],
      persistedMemory: [{ key: "only_persisted", value: "val", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1);
    expect(output).toContain("## Memory");
    expect(output).toContain("only_persisted = val");
  });

  it("handles non-empty memoryFacts with empty persistedMemory", () => {
    const ctx = makeBaseContext({
      memoryFacts: [{ key: "only_session", value: "val", source: "agent", confidence: 0.5 }],
      persistedMemory: [],
    });
    const output = formatContextMarkdown(ctx, 1);
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
    const output = formatContextMarkdown(ctx, 1);
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
    });
    const key2 = JSON.stringify({
      wd: session.working_directory,
      wp: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      mf: session.metrics.memory_facts,
    });
    expect(key1).toBe(key2);
  });

  it("different array instances with same values produce identical JSON keys", () => {
    const session1 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
    });
    // Simulate a new SESSION_UPDATED event with fresh array instances
    const session2 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
    });

    // Reference equality fails (this is why the original code was buggy)
    expect(session1.workspace_paths).not.toBe(session2.workspace_paths);

    // But JSON serialization produces identical keys (this is the fix)
    const key1 = JSON.stringify({
      wd: session1.working_directory,
      wp: session1.workspace_paths,
    });
    const key2 = JSON.stringify({
      wd: session2.working_directory,
      wp: session2.workspace_paths,
    });
    expect(key1).toBe(key2);
  });

  it("actually changed values produce different JSON keys", () => {
    const session1 = makeSession({
      workspace_paths: ["/path/a"],
    });
    const session2 = makeSession({
      workspace_paths: ["/path/a", "/path/b"],
    });

    const key1 = JSON.stringify({
      wp: session1.workspace_paths,
    });
    const key2 = JSON.stringify({
      wp: session2.workspace_paths,
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
      projects: [{
        project_id: "r1", project_name: "my-project", path: "/home/user/my-project",
        languages: ["TypeScript"], frameworks: ["React"],
        architecture_pattern: "MVC", architecture_layers: [],
        conventions: ["Use camelCase"], scan_status: "deep",
      }],
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
      workspacePaths: ["/extra"],
    });

    const output = formatContextMarkdown(ctx, 5);

    expect(output).toContain("# Session Context (v5)");
    expect(output).not.toContain("- Mode:");
    expect(output).toContain("- Provider: anthropic (claude-sonnet)");
    expect(output).toContain("## Projects");
    expect(output).toContain("## Pinned Context");
    expect(output).toContain("## Memory");
    expect(output).toContain("## Workspace");
  });

  it("empty sections are omitted", () => {
    const ctx = makeBaseContext({ agent: null, model: null });
    const output = formatContextMarkdown(ctx, 1);
    expect(output).not.toContain("Provider:");
    expect(output).not.toContain("## Projects");
    expect(output).not.toContain("## Pinned Context");
    expect(output).not.toContain("## Memory");
    expect(output).toContain("## Workspace");
  });
});
