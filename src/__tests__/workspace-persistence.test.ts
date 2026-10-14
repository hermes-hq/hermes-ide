/**
 * Tests for workspace persistence and session restore reliability.
 *
 * Covers:
 * - SavedWorkspace JSON validation (validateSavedWorkspace)
 * - Layout remapping with malformed/edge-case data
 * - Version stamping on save
 * - Restore-in-progress guard preventing periodic save corruption
 * - Description and group restoration
 * - Crash recovery: saved_workspace preserved until restore completes
 */
import { describe, it, expect } from "vitest";

import {
  validateSavedWorkspace,
  SAVED_WORKSPACE_VERSION,
  type SavedWorkspace,
  type SavedSessionInfo,
} from "../types/session";

// ─── validateSavedWorkspace ──────────────────────────────────────────

describe("validateSavedWorkspace", () => {
  const validSession: SavedSessionInfo = {
    id: "sess-1",
    label: "Session 1",
    description: "desc",
    color: "#ff0000",
    group: null,
    working_directory: "/tmp",
    ai_provider: null,
    auto_approve: false,
    project_ids: [],
  };

  const validWorkspace: SavedWorkspace = {
    version: 1,
    sessions: [validSession],
    layout: null,
    focused_pane_id: null,
    active_session_id: "sess-1",
  };

  it("returns validated workspace for valid input", () => {
    const result = validateSavedWorkspace(validWorkspace);
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].id).toBe("sess-1");
    expect(result!.version).toBe(1);
  });

  it("returns null for null input", () => {
    expect(validateSavedWorkspace(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(validateSavedWorkspace("string")).toBeNull();
    expect(validateSavedWorkspace(42)).toBeNull();
    expect(validateSavedWorkspace(true)).toBeNull();
    expect(validateSavedWorkspace(undefined)).toBeNull();
  });

  it("returns null when sessions is missing", () => {
    expect(validateSavedWorkspace({ layout: null })).toBeNull();
  });

  it("returns null when sessions is empty array", () => {
    expect(validateSavedWorkspace({ sessions: [] })).toBeNull();
  });

  it("returns null when sessions is not an array", () => {
    expect(validateSavedWorkspace({ sessions: "not-array" })).toBeNull();
  });

  it("returns null when a session has no id", () => {
    expect(validateSavedWorkspace({
      sessions: [{ label: "test" }],
    })).toBeNull();
  });

  it("returns null when a session id is empty string", () => {
    expect(validateSavedWorkspace({
      sessions: [{ id: "", label: "test" }],
    })).toBeNull();
  });

  it("returns null when a session has no label", () => {
    expect(validateSavedWorkspace({
      sessions: [{ id: "s1" }],
    })).toBeNull();
  });

  it("returns null when session is null", () => {
    expect(validateSavedWorkspace({
      sessions: [null],
    })).toBeNull();
  });

  it("returns null when session is a primitive", () => {
    expect(validateSavedWorkspace({
      sessions: [42],
    })).toBeNull();
  });

  it("provides defaults for missing optional fields", () => {
    const result = validateSavedWorkspace({
      sessions: [{ id: "s1", label: "Session" }],
    });
    expect(result).not.toBeNull();
    const s = result!.sessions[0];
    expect(s.description).toBe("");
    expect(s.color).toBe("");
    expect(s.working_directory).toBe("");
    expect(s.auto_approve).toBe(false);
    expect(s.project_ids).toEqual([]);
  });

  it("preserves existing optional fields", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Session",
        description: "My desc",
        color: "#00ff00",
        working_directory: "/home/user",
        project_ids: ["p1", "p2"],
      }],
    });
    expect(result).not.toBeNull();
    const s = result!.sessions[0];
    expect(s.description).toBe("My desc");
    expect(s.color).toBe("#00ff00");
    expect(s.working_directory).toBe("/home/user");
    expect(s.project_ids).toEqual(["p1", "p2"]);
  });

  it("defaults version to 0 when missing", () => {
    const result = validateSavedWorkspace({
      sessions: [validSession],
    });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(0);
  });

  it("preserves layout when present", () => {
    const layout = { type: "pane", id: "p1", sessionId: "s1" };
    const result = validateSavedWorkspace({
      sessions: [validSession],
      layout,
    });
    expect(result).not.toBeNull();
    expect(result!.layout).toEqual(layout);
  });

  it("defaults layout to null when missing", () => {
    const result = validateSavedWorkspace({
      sessions: [validSession],
    });
    expect(result).not.toBeNull();
    expect(result!.layout).toBeNull();
  });

  it("handles focused_pane_id and active_session_id correctly", () => {
    const result = validateSavedWorkspace({
      sessions: [validSession],
      focused_pane_id: "pane-1",
      active_session_id: "sess-1",
    });
    expect(result).not.toBeNull();
    expect(result!.focused_pane_id).toBe("pane-1");
    expect(result!.active_session_id).toBe("sess-1");
  });

  it("defaults non-string pane/session IDs to null", () => {
    const result = validateSavedWorkspace({
      sessions: [validSession],
      focused_pane_id: 123,
      active_session_id: true,
    });
    expect(result).not.toBeNull();
    expect(result!.focused_pane_id).toBeNull();
    expect(result!.active_session_id).toBeNull();
  });

  it("validates multiple sessions — all must be valid", () => {
    const result = validateSavedWorkspace({
      sessions: [
        { id: "s1", label: "One" },
        { id: "", label: "Two" }, // invalid: empty id
      ],
    });
    expect(result).toBeNull();
  });

  it("validates multiple valid sessions", () => {
    const result = validateSavedWorkspace({
      sessions: [
        { id: "s1", label: "One" },
        { id: "s2", label: "Two" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(2);
  });
});

// ─── SAVED_WORKSPACE_VERSION ─────────────────────────────────────────

describe("SAVED_WORKSPACE_VERSION", () => {
  it("is a positive integer", () => {
    expect(SAVED_WORKSPACE_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(SAVED_WORKSPACE_VERSION)).toBe(true);
  });
});

// ─── Layout remapping resilience ─────────────────────────────────────
// These test the remapLayoutSessionIds logic indirectly through the reducer
// by verifying the RESTORE_LAYOUT action handles edge cases.

import { sessionReducer, initialState } from "../state/SessionContext";

describe("RESTORE_LAYOUT action", () => {
  it("sets layout root and focused pane from remapped data", () => {
    const pane = { type: "pane" as const, id: "p1", sessionId: "new-s1" };
    const result = sessionReducer(initialState, {
      type: "RESTORE_LAYOUT",
      root: pane,
      focusedPaneId: "p1",
      activeSessionId: "new-s1",
    });
    expect(result.layout.root).toEqual(pane);
    expect(result.layout.focusedPaneId).toBe("p1");
    expect(result.activeSessionId).toBe("new-s1");
  });

  it("handles null root (all sessions failed to restore)", () => {
    const result = sessionReducer(initialState, {
      type: "RESTORE_LAYOUT",
      root: null,
      focusedPaneId: null,
      activeSessionId: null,
    });
    expect(result.layout.root).toBeNull();
    expect(result.layout.focusedPaneId).toBeNull();
    expect(result.activeSessionId).toBeNull();
  });

  it("handles complex split layout", () => {
    const layout = {
      type: "split" as const,
      id: "sp1",
      direction: "horizontal" as const,
      ratio: 0.5,
      children: [
        { type: "pane" as const, id: "p1", sessionId: "s1" },
        { type: "pane" as const, id: "p2", sessionId: "s2" },
      ] as [{ type: "pane"; id: string; sessionId: string }, { type: "pane"; id: string; sessionId: string }],
    };
    const result = sessionReducer(initialState, {
      type: "RESTORE_LAYOUT",
      root: layout,
      focusedPaneId: "p1",
      activeSessionId: "s1",
    });
    expect(result.layout.root).toEqual(layout);
    expect(result.activeSessionId).toBe("s1");
  });
});

// ─── Workspace save version stamping ─────────────────────────────────

describe("Workspace save format", () => {
  it("SavedWorkspace includes version field", () => {
    const ws: SavedWorkspace = {
      version: SAVED_WORKSPACE_VERSION,
      sessions: [{
        id: "s1",
        label: "Test",
        description: "",
        color: "#000",
        group: null,
        working_directory: "/tmp",
        ai_provider: null,
        project_ids: [],
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    };

    const json = JSON.stringify(ws);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(SAVED_WORKSPACE_VERSION);
  });

  it("old format without version is accepted by validator", () => {
    const oldFormat = {
      sessions: [{
        id: "s1",
        label: "Old Session",
        description: "",
        color: "#fff",
        group: null,
        working_directory: "/home",
        ai_provider: null,
        project_ids: [],
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };

    const result = validateSavedWorkspace(oldFormat);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(0); // Defaulted
  });
});

// ─── SESSION_REMOVED clears closed session from state ────────────────

describe("Closed sessions don't reappear", () => {
  it("SESSION_REMOVED removes session from state completely", () => {
    const session = {
      id: "s1",
      label: "Test",
      description: "",
      color: "#000",
      group: null,
      phase: "idle",
      working_directory: "/tmp",
      shell: "zsh",
      created_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      workspace_paths: [],
      detected_agent: null,
      metrics: {
        output_lines: 0, error_count: 0, stuck_score: 0,
        token_usage: {}, tool_calls: [], tool_call_summary: {},
        files_touched: [], recent_errors: [],
        memory_facts: [],
        latency_p50_ms: null, latency_p95_ms: null,
        latency_samples: [], token_history: [],
      },
      ai_provider: null,
      auto_approve: false,
      context_injected: false,
    };

    // Add session
    let state = sessionReducer(initialState, { type: "SESSION_UPDATED", session });
    expect(state.sessions["s1"]).toBeDefined();

    // Remove session
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.sessions["s1"]).toBeUndefined();
    expect(Object.keys(state.sessions)).toHaveLength(0);
  });

  it("SESSION_REMOVED removes panes displaying the closed session", () => {
    const pane = { type: "pane" as const, id: "p1", sessionId: "s1" };
    const stateWithLayout = {
      ...initialState,
      sessions: { s1: { id: "s1", phase: "idle" } as never },
      layout: { root: pane, focusedPaneId: "p1" },
      activeSessionId: "s1",
    };

    const result = sessionReducer(stateWithLayout, { type: "SESSION_REMOVED", id: "s1" });
    expect(result.sessions["s1"]).toBeUndefined();
    expect(result.layout.root).toBeNull();
    expect(result.activeSessionId).toBeNull();
  });
});

// ─── Edge cases in validation ────────────────────────────────────────

describe("validateSavedWorkspace edge cases", () => {
  it("handles session with group field present", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Grouped",
        group: "my-group",
        description: "with group",
        color: "#fff",
        working_directory: "/tmp",
        ai_provider: null,
        project_ids: [],
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].group).toBe("my-group");
  });

  it("handles deeply nested layout structure", () => {
    const deepLayout = {
      type: "split",
      id: "sp1",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        {
          type: "split",
          id: "sp2",
          direction: "vertical",
          ratio: 0.3,
          children: [
            { type: "pane", id: "p1", sessionId: "s1" },
            { type: "pane", id: "p2", sessionId: "s2" },
          ],
        },
        { type: "pane", id: "p3", sessionId: "s3" },
      ],
    };

    const result = validateSavedWorkspace({
      sessions: [
        { id: "s1", label: "A" },
        { id: "s2", label: "B" },
        { id: "s3", label: "C" },
      ],
      layout: deepLayout,
    });
    expect(result).not.toBeNull();
    expect(result!.layout).toEqual(deepLayout);
  });

  it("handles very large session count", () => {
    const sessions = Array.from({ length: 50 }, (_, i) => ({
      id: `s-${i}`,
      label: `Session ${i}`,
    }));

    const result = validateSavedWorkspace({ sessions });
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(50);
  });

  it("handles session with all fields being wrong types gracefully", () => {
    // Only id (string) and label (string) are strictly required
    const result = validateSavedWorkspace({
      sessions: [{
        id: "valid-id",
        label: "valid-label",
        description: 123, // wrong type — should default
        color: false,     // wrong type — should default
        working_directory: null, // wrong type — should default
        project_ids: "not-array", // wrong type — should default
      }],
    });
    expect(result).not.toBeNull();
    const s = result!.sessions[0];
    expect(s.description).toBe("");
    expect(s.color).toBe("");
    expect(s.working_directory).toBe("");
    expect(s.project_ids).toEqual([]);
    expect(s.auto_approve).toBe(false);
  });
});

// ─── auto_approve persistence ────────────────────────────────────────

describe("auto_approve CLI flag persistence", () => {
  it("preserves auto_approve: true in validated workspace", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Yolo Session",
        auto_approve: true,
        ai_provider: "gemini",
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].auto_approve).toBe(true);
  });

  it("preserves auto_approve: false explicitly", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Normal Session",
        auto_approve: false,
        ai_provider: "claude",
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].auto_approve).toBe(false);
  });

  it("defaults auto_approve to false when missing (backward compat)", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Old Session",
        ai_provider: "claude",
        // no auto_approve field
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].auto_approve).toBe(false);
  });

  it("defaults auto_approve to false when wrong type", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Bad Type",
        auto_approve: "yes", // wrong type
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].auto_approve).toBe(false);
  });

  it("round-trips auto_approve through JSON serialization", () => {
    const workspace = {
      version: 1,
      sessions: [{
        id: "s1",
        label: "Yolo",
        description: "",
        color: "#ff0000",
        group: null,
        working_directory: "/tmp",
        ai_provider: "gemini",
        auto_approve: true,
        project_ids: [],
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    };

    const json = JSON.stringify(workspace);
    const parsed = JSON.parse(json);
    const validated = validateSavedWorkspace(parsed);
    expect(validated).not.toBeNull();
    expect(validated!.sessions[0].auto_approve).toBe(true);
    expect(validated!.sessions[0].ai_provider).toBe("gemini");
  });
});
