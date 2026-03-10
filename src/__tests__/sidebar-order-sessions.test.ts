/**
 * Tests for sidebarOrderSessions — ensures CMD+1-9 shortcuts
 * match the visual session order in the sidebar.
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
  sidebarOrderSessions,
  type SessionData,
} from "../state/SessionContext";

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

// =====================================================================
// sidebarOrderSessions
// =====================================================================
describe("sidebarOrderSessions", () => {
  it("returns empty array for no sessions", () => {
    expect(sidebarOrderSessions([])).toEqual([]);
  });

  it("preserves order when all sessions are ungrouped and active", () => {
    const sessions = [
      makeSession({ id: "a", label: "A" }),
      makeSession({ id: "b", label: "B" }),
      makeSession({ id: "c", label: "C" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts destroyed ungrouped sessions to the bottom", () => {
    const sessions = [
      makeSession({ id: "destroyed-1", phase: "destroyed" }),
      makeSession({ id: "active-1", phase: "idle" }),
      makeSession({ id: "active-2", phase: "busy" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual(["active-1", "active-2", "destroyed-1"]);
  });

  it("places named groups before ungrouped sessions", () => {
    const sessions = [
      makeSession({ id: "ungrouped", group: null }),
      makeSession({ id: "grouped", group: "ProjectA" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual(["grouped", "ungrouped"]);
  });

  it("sorts named groups alphabetically", () => {
    const sessions = [
      makeSession({ id: "z-proj", group: "Zeta" }),
      makeSession({ id: "a-proj", group: "Alpha" }),
      makeSession({ id: "m-proj", group: "Mid" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual(["a-proj", "m-proj", "z-proj"]);
  });

  it("sorts destroyed sessions to the bottom within each group", () => {
    const sessions = [
      makeSession({ id: "a-destroyed", group: "Alpha", phase: "destroyed" }),
      makeSession({ id: "a-active", group: "Alpha", phase: "idle" }),
      makeSession({ id: "b-destroyed", group: "Beta", phase: "destroyed" }),
      makeSession({ id: "b-active", group: "Beta", phase: "busy" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual([
      "a-active",
      "a-destroyed",
      "b-active",
      "b-destroyed",
    ]);
  });

  it("handles mixed grouped and ungrouped with destroyed sessions", () => {
    const sessions = [
      makeSession({ id: "ung-destroyed", group: null, phase: "destroyed" }),
      makeSession({ id: "ung-active", group: null, phase: "idle" }),
      makeSession({ id: "proj-destroyed", group: "MyProject", phase: "destroyed" }),
      makeSession({ id: "proj-active", group: "MyProject", phase: "idle" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    expect(ordered.map((s) => s.id)).toEqual([
      "proj-active",
      "proj-destroyed",
      "ung-active",
      "ung-destroyed",
    ]);
  });

  it("CMD+1 through CMD+9 would map to correct sessions", () => {
    // Simulate a realistic scenario: two projects + ungrouped
    const sessions = [
      makeSession({ id: "ung-1", group: null }),
      makeSession({ id: "backend-1", group: "Backend" }),
      makeSession({ id: "api-1", group: "API" }),
      makeSession({ id: "api-2", group: "API" }),
      makeSession({ id: "backend-2", group: "Backend", phase: "destroyed" }),
      makeSession({ id: "ung-2", group: null, phase: "destroyed" }),
    ];
    const ordered = sidebarOrderSessions(sessions);
    // Expected: API (alpha first) → Backend → Ungrouped, destroyed last in each
    expect(ordered.map((s) => s.id)).toEqual([
      "api-1",       // CMD+1
      "api-2",       // CMD+2
      "backend-1",   // CMD+3
      "backend-2",   // CMD+4 (destroyed, but still in Backend group)
      "ung-1",       // CMD+5
      "ung-2",       // CMD+6 (destroyed ungrouped)
    ]);
  });

  it("does not mutate the input array", () => {
    const sessions = [
      makeSession({ id: "b", group: "B" }),
      makeSession({ id: "a", group: "A" }),
    ];
    const copy = [...sessions];
    sidebarOrderSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(copy.map((s) => s.id));
  });
});
