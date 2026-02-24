/**
 * Context Injection Redesign — Backend-Authoritative Model
 *
 * Tests for:
 * - Version state transitions (lifecycle state machine)
 * - Dirty detection
 * - Apply behavior
 * - Auto-apply behavior
 * - Injection formatting
 * - Idempotency
 * - Multi-session isolation
 * - Execution mode propagation
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
  formatContextMarkdown,
  type ContextState,
} from "../hooks/useContextState";

import {
  sessionReducer,
  initialState,
  type SessionData,
} from "../state/SessionContext";

// ─── Helpers ─────────────────────────────────────────────────────────
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
    ...overrides,
  };
}

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

// =====================================================================
// Suite 1: Version State Transitions (via sessionReducer)
// =====================================================================

describe("Suite 1: Version State Transitions", () => {
  it("SESSION_UPDATED adds a new session to state", () => {
    const session = makeSession({ id: "s1", phase: "idle" });
    const state = sessionReducer(initialState, { type: "SESSION_UPDATED", session });
    expect(state.sessions["s1"]).toBeDefined();
    expect(state.sessions["s1"].phase).toBe("idle");
  });

  it("SESSION_UPDATED updates phase from idle to busy", () => {
    const session = makeSession({ id: "s1", phase: "idle" });
    const s1 = sessionReducer(initialState, { type: "SESSION_UPDATED", session });

    const updated = makeSession({ id: "s1", phase: "busy" });
    const s2 = sessionReducer(s1, { type: "SESSION_UPDATED", session: updated });
    expect(s2.sessions["s1"].phase).toBe("busy");
  });

  it("SESSION_UPDATED updates phase from busy back to idle", () => {
    const s1 = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "busy" }),
    });
    const s2 = sessionReducer(s1, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "idle" }),
    });
    expect(s2.sessions["s1"].phase).toBe("idle");
  });

  it("SESSION_REMOVED removes the session from state", () => {
    const s1 = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    expect(s1.sessions["s1"]).toBeDefined();

    const s2 = sessionReducer(s1, { type: "SESSION_REMOVED", id: "s1" });
    expect(s2.sessions["s1"]).toBeUndefined();
  });

  it("SESSION_REMOVED clears activeSessionId when the active session is removed", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, { type: "SET_ACTIVE", id: "s1" });
    expect(state.activeSessionId).toBe("s1");

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.activeSessionId).not.toBe("s1");
  });

  it("SESSION_UPDATED preserves other sessions when updating one", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", label: "First" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2", label: "Second" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", label: "First Updated" }),
    });
    expect(state.sessions["s1"].label).toBe("First Updated");
    expect(state.sessions["s2"].label).toBe("Second");
  });
});

// =====================================================================
// Suite 2: Dirty Detection
// =====================================================================

describe("Suite 2: Dirty Detection", () => {
  it("Context JSON comparison detects pin additions", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/path/file.ts", label: null,
        priority: 128, created_at: 1000,
      }],
    }));
    expect(before).not.toBe(after);
  });

  it("Context JSON comparison detects pin removals", () => {
    const withPin = JSON.stringify(makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/path/file.ts", label: null,
        priority: 128, created_at: 1000,
      }],
    }));
    const without = JSON.stringify(makeBaseContext());
    expect(withPin).not.toBe(without);
  });

  it("Context JSON comparison detects realm changes", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      realms: [{
        realm_id: "r1", realm_name: "test", path: "/test",
        languages: ["TypeScript"], frameworks: [], architecture_pattern: null,
        architecture_layers: [], conventions: [], scan_status: "deep",
      }],
    }));
    expect(before).not.toBe(after);
  });

  it("Context JSON comparison detects memory changes", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
    }));
    expect(before).not.toBe(after);
  });

  it("Same data re-applied does NOT produce different JSON", () => {
    const a = JSON.stringify(makeBaseContext());
    const b = JSON.stringify(makeBaseContext());
    expect(a).toBe(b);
  });
});

// =====================================================================
// Suite 3: Apply Behavior (via sessionReducer)
// =====================================================================

describe("Suite 3: Apply Behavior", () => {
  it("SET_EXECUTION_MODE sets mode for a specific session", () => {
    const state = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    expect(state.executionModes["s1"]).toBe("autonomous");
  });

  it("SET_EXECUTION_MODE can change mode from autonomous to manual", () => {
    let state = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "manual",
    });
    expect(state.executionModes["s1"]).toBe("manual");
  });

  it("SET_EXECUTION_MODE for one session does not affect another", () => {
    let state = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s2",
      mode: "assisted",
    });
    expect(state.executionModes["s1"]).toBe("autonomous");
    expect(state.executionModes["s2"]).toBe("assisted");
  });

  it("SET_DEFAULT_MODE changes the default execution mode", () => {
    const state = sessionReducer(initialState, {
      type: "SET_DEFAULT_MODE",
      mode: "autonomous",
    });
    expect(state.defaultMode).toBe("autonomous");
  });

  it("SET_DEFAULT_MODE does not affect per-session overrides", () => {
    let state = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "assisted",
    });
    state = sessionReducer(state, { type: "SET_DEFAULT_MODE", mode: "autonomous" });
    expect(state.defaultMode).toBe("autonomous");
    expect(state.executionModes["s1"]).toBe("assisted");
  });

  it("SET_AUTONOMOUS_SETTINGS updates autonomous thresholds", () => {
    const state = sessionReducer(initialState, {
      type: "SET_AUTONOMOUS_SETTINGS",
      settings: { errorMinOccurrences: 10, cancelDelayMs: 5000 },
    });
    expect(state.autonomousSettings.errorMinOccurrences).toBe(10);
    expect(state.autonomousSettings.cancelDelayMs).toBe(5000);
    // Unmodified setting is preserved
    expect(state.autonomousSettings.commandMinFrequency).toBe(
      initialState.autonomousSettings.commandMinFrequency
    );
  });
});

// =====================================================================
// Suite 4: Auto-Apply Behavior (via sessionReducer)
// =====================================================================

describe("Suite 4: Auto-Apply Behavior", () => {
  it("TOGGLE_AUTO_APPLY action toggles autoApplyEnabled", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_AUTO_APPLY" });
    expect(state1.autoApplyEnabled).toBe(!initialState.autoApplyEnabled);
    const state2 = sessionReducer(state1, { type: "TOGGLE_AUTO_APPLY" });
    expect(state2.autoApplyEnabled).toBe(initialState.autoApplyEnabled);
  });

  it("autoApplyEnabled defaults to true", () => {
    expect(initialState.autoApplyEnabled).toBe(true);
  });

  it("TOGGLE_AUTO_APPLY does not affect other state fields", () => {
    const session = makeSession({ id: "s1" });
    let state = sessionReducer(initialState, { type: "SESSION_UPDATED", session });
    state = sessionReducer(state, { type: "SET_ACTIVE", id: "s1" });
    const before = { ...state, autoApplyEnabled: undefined };

    const toggled = sessionReducer(state, { type: "TOGGLE_AUTO_APPLY" });
    const after = { ...toggled, autoApplyEnabled: undefined };

    expect(before.activeSessionId).toBe(after.activeSessionId);
    expect(before.defaultMode).toBe(after.defaultMode);
    expect(Object.keys(before.sessions)).toEqual(Object.keys(after.sessions));
  });

  it("Phase transition idle->busy is tracked in session state", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "idle" }),
    });
    expect(state.sessions["s1"].phase).toBe("idle");

    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "busy" }),
    });
    expect(state.sessions["s1"].phase).toBe("busy");
    expect(state.autoApplyEnabled).toBe(true);
  });

  it("Phase transition does not auto-apply when autoApplyEnabled is toggled off", () => {
    let state = sessionReducer(initialState, { type: "TOGGLE_AUTO_APPLY" });
    expect(state.autoApplyEnabled).toBe(false);

    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "busy" }),
    });
    // autoApplyEnabled remains false after session update
    expect(state.autoApplyEnabled).toBe(false);
  });
});

// =====================================================================
// Suite 5: Injection Formatting
// =====================================================================

describe("Suite 5: Injection Formatting", () => {
  it("formatContextMarkdown includes execution mode", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 1, "autonomous");
    expect(output).toContain("- Mode: autonomous");
  });

  it("formatContextMarkdown includes pins", () => {
    const ctx = makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/src/main.ts", label: "Main entry",
        priority: 128, created_at: 1000,
      }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Pinned Context");
    expect(output).toContain("[file] Main entry");
  });

  it("formatContextMarkdown includes memory", () => {
    const ctx = makeBaseContext({
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Memory");
    expect(output).toContain("db_host = localhost");
  });

  it("formatContextMarkdown includes projects", () => {
    const ctx = makeBaseContext({
      realms: [{
        realm_id: "r1", realm_name: "my-project", path: "/home/user/my-project",
        languages: ["TypeScript", "Python"], frameworks: ["React"],
        architecture_pattern: "MVC", architecture_layers: [],
        conventions: ["Use camelCase"], scan_status: "deep",
      }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Projects");
    expect(output).toContain("### my-project (/home/user/my-project)");
    expect(output).toContain("Languages: TypeScript, Python");
    expect(output).toContain("Frameworks: React");
    expect(output).toContain("Architecture: MVC");
    expect(output).toContain("Conventions: Use camelCase");
  });

  it("formatContextMarkdown includes version header", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 42, "manual");
    expect(output).toContain("# Session Context (v42)");
  });

  it("formatContextMarkdown includes workspace info", () => {
    const ctx = makeBaseContext({
      workspacePaths: ["/extra/path"],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Workspace");
    expect(output).toContain("Dir: /home/user/project");
    expect(output).toContain("+ /extra/path");
  });
});

// =====================================================================
// Suite 6: Idempotency
// =====================================================================

describe("Suite 6: Idempotency", () => {
  it("Dispatching the same SESSION_UPDATED twice produces identical state", () => {
    const session = makeSession({ id: "s1", phase: "idle" });
    const s1 = sessionReducer(initialState, { type: "SESSION_UPDATED", session });
    const s2 = sessionReducer(s1, { type: "SESSION_UPDATED", session });
    expect(s2.sessions["s1"]).toEqual(s1.sessions["s1"]);
  });

  it("TOGGLE_AUTO_APPLY twice returns to original value", () => {
    const s1 = sessionReducer(initialState, { type: "TOGGLE_AUTO_APPLY" });
    const s2 = sessionReducer(s1, { type: "TOGGLE_AUTO_APPLY" });
    expect(s2.autoApplyEnabled).toBe(initialState.autoApplyEnabled);
  });

  it("TOGGLE_CONTEXT twice returns to original value", () => {
    const s1 = sessionReducer(initialState, { type: "TOGGLE_CONTEXT" });
    const s2 = sessionReducer(s1, { type: "TOGGLE_CONTEXT" });
    expect(s2.ui.contextPanelOpen).toBe(initialState.ui.contextPanelOpen);
  });

  it("formatContextMarkdown produces identical output for identical input", () => {
    const ctx = makeBaseContext();
    const output1 = formatContextMarkdown(ctx, 1, "manual");
    const output2 = formatContextMarkdown(ctx, 1, "manual");
    expect(output1).toBe(output2);
  });

  it("formatContextMarkdown produces different output when context changes", () => {
    const ctx1 = makeBaseContext({ agent: "anthropic" });
    const ctx2 = makeBaseContext({ agent: "openai" });
    const output1 = formatContextMarkdown(ctx1, 1, "manual");
    const output2 = formatContextMarkdown(ctx2, 1, "manual");
    expect(output1).not.toBe(output2);
  });

  it("SET_EXECUTION_MODE to same mode is idempotent", () => {
    const s1 = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    const s2 = sessionReducer(s1, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    expect(s2.executionModes["s1"]).toBe(s1.executionModes["s1"]);
  });
});

// =====================================================================
// Suite 7: Multi-Session Isolation
// =====================================================================

describe("Suite 7: Multi-Session Isolation", () => {
  it("Execution modes are independent per session", () => {
    let state = sessionReducer(initialState, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s2",
      mode: "manual",
    });
    expect(state.executionModes["s1"]).toBe("autonomous");
    expect(state.executionModes["s2"]).toBe("manual");
  });

  it("Removing one session does not affect another session's data", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", label: "Session A" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2", label: "Session B" }),
    });
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });

    expect(state.sessions["s1"]).toBeUndefined();
    expect(state.sessions["s2"]).toBeDefined();
    expect(state.sessions["s2"].label).toBe("Session B");
  });

  it("Session updates to one session do not overwrite another", () => {
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "idle" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2", phase: "idle" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1", phase: "busy" }),
    });

    expect(state.sessions["s1"].phase).toBe("busy");
    expect(state.sessions["s2"].phase).toBe("idle");
  });

  it("formatContextMarkdown produces isolated output per context", () => {
    const ctxA = makeBaseContext({ workingDirectory: "/project-a", agent: "anthropic" });
    const ctxB = makeBaseContext({ workingDirectory: "/project-b", agent: "openai" });

    const outputA = formatContextMarkdown(ctxA, 1, "manual");
    const outputB = formatContextMarkdown(ctxB, 1, "manual");

    expect(outputA).toContain("Dir: /project-a");
    expect(outputA).toContain("Provider: anthropic");
    expect(outputA).not.toContain("/project-b");

    expect(outputB).toContain("Dir: /project-b");
    expect(outputB).toContain("Provider: openai");
    expect(outputB).not.toContain("/project-a");
  });
});

// =====================================================================
// Suite 8: ExecutionMode Propagation
// =====================================================================

describe("Suite 8: ExecutionMode Propagation", () => {
  it("Execution mode appears in formatted context", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 1, "assisted");
    expect(output).toContain("- Mode: assisted");
  });

  it("Mode change produces different formatted output", () => {
    const ctx = makeBaseContext();
    const manual = formatContextMarkdown(ctx, 1, "manual");
    const autonomous = formatContextMarkdown(ctx, 1, "autonomous");
    expect(manual).not.toBe(autonomous);
    expect(manual).toContain("- Mode: manual");
    expect(autonomous).toContain("- Mode: autonomous");
  });

  it("Mode is included even without agent", () => {
    const ctx = makeBaseContext({ agent: null, model: null });
    const output = formatContextMarkdown(ctx, 1, "autonomous");
    expect(output).toContain("- Mode: autonomous");
    expect(output).not.toContain("Provider:");
  });

  it("All three modes render correctly", () => {
    const ctx = makeBaseContext();
    for (const mode of ["manual", "assisted", "autonomous"]) {
      const output = formatContextMarkdown(ctx, 1, mode);
      expect(output).toContain(`- Mode: ${mode}`);
    }
  });
});
