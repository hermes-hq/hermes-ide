/**
 * Session Mode Test Suite
 *
 * Covers Phase 4 of the v1.0 plan:
 *   - The new SessionData.mode field ("terminal" | "agent")
 *   - The SET_SESSION_MODE reducer action
 *   - Workspace-restore default-mode logic (back-compat with 0.6.16 saves)
 *   - resolveSessionMode() — the rule that picks the default mode for a
 *     newly-created session based on the AI provider.
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
  focusTerminal: vi.fn(),
  refitActive: vi.fn(),
  estimateInitialDimensions: vi.fn(() => ({ rows: 24, cols: 80 })),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState, resolveSessionMode } from "../state/SessionContext";
import { validateSavedWorkspace } from "../types/session";
import type { SessionData, SessionMode } from "../types/session";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    description: "",
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
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "terminal",
    ...overrides,
  };
}

// =====================================================================
// SET_SESSION_MODE reducer
// =====================================================================
describe("session mode", () => {
  it("SET_SESSION_MODE updates mode for that session only", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "a", mode: "terminal" }) });
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "b", mode: "terminal" }) });

    state = sessionReducer(state, { type: "SET_SESSION_MODE", sessionId: "a", mode: "agent" });

    expect(state.sessions["a"].mode).toBe("agent");
    expect(state.sessions["b"].mode).toBe("terminal");
  });

  it("SET_SESSION_MODE is a no-op when the mode is unchanged", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "a", mode: "terminal" }) });
    const before = state;

    state = sessionReducer(state, { type: "SET_SESSION_MODE", sessionId: "a", mode: "terminal" });

    // Same reference — no work done.
    expect(state).toBe(before);
  });

  it("SET_SESSION_MODE on an unknown session is a no-op", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "a" }) });
    const before = state;

    state = sessionReducer(state, { type: "SET_SESSION_MODE", sessionId: "ghost", mode: "agent" });

    expect(state).toBe(before);
  });
});

// =====================================================================
// validateSavedWorkspace — workspace-restore default-mode
// =====================================================================
describe("workspace restore: mode defaulting", () => {
  it("workspace restore defaults missing mode to 'terminal'", () => {
    const raw = {
      version: 1,
      sessions: [
        {
          id: "old-1",
          label: "Old Session",
          description: "",
          color: "",
          group: null,
          working_directory: "/x",
          ai_provider: "claude",
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: [],
          // no mode field — simulates 0.6.16 save
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };
    const result = validateSavedWorkspace(raw);
    expect(result).not.toBeNull();
    expect(result!.sessions[0].mode).toBe("terminal");
  });

  it("workspace restore preserves an explicit 'agent' mode", () => {
    const raw = {
      version: 1,
      sessions: [
        {
          id: "agent-1",
          label: "Agent",
          description: "",
          color: "",
          group: null,
          working_directory: "/x",
          ai_provider: "claude",
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: [],
          mode: "agent",
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };
    const result = validateSavedWorkspace(raw);
    expect(result).not.toBeNull();
    expect(result!.sessions[0].mode).toBe("agent");
  });

  it("rejects an unknown mode value and falls back to 'terminal'", () => {
    const raw = {
      version: 1,
      sessions: [
        {
          id: "weird",
          label: "Weird",
          description: "",
          color: "",
          group: null,
          working_directory: "/x",
          ai_provider: "claude",
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: [],
          mode: "tui-mode-from-future",
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };
    const result = validateSavedWorkspace(raw);
    expect(result).not.toBeNull();
    expect(result!.sessions[0].mode).toBe("terminal");
  });
});

// =====================================================================
// resolveSessionMode — default-mode rule for newly-created sessions
// =====================================================================
describe("resolveSessionMode", () => {
  it("createSession with claude provider defaults mode to 'agent'", () => {
    const mode: SessionMode = resolveSessionMode(undefined, "claude");
    expect(mode).toBe("agent");
  });

  it("createSession with non-claude provider locks mode to 'terminal'", () => {
    expect(resolveSessionMode(undefined, "codex")).toBe("terminal");
    expect(resolveSessionMode(undefined, "gemini")).toBe("terminal");
    expect(resolveSessionMode(undefined, null)).toBe("terminal");
    expect(resolveSessionMode(undefined, undefined)).toBe("terminal");
  });

  it("non-claude providers reject an explicit 'agent' request", () => {
    // Agent mode is Claude-only in 1.0.0 — non-Claude providers always
    // fall back to terminal even when the caller asks for agent.
    expect(resolveSessionMode("agent", "codex")).toBe("terminal");
    expect(resolveSessionMode("agent", null)).toBe("terminal");
  });

  it("claude provider honours an explicit 'terminal' request", () => {
    // The user clicked "Open as terminal instead" — respect it.
    expect(resolveSessionMode("terminal", "claude")).toBe("terminal");
  });
});
