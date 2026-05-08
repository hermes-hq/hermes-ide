/**
 * Saved-workspace v2 schema pinned by these tests.  v2 added the
 * agent-mode persistence fields: `claude_session_uuid`, `agent_model`,
 * `agent_permission_mode`, `agent_effort`, `agent_add_dirs`.
 *
 * These tests don't run the reducer — they validate the on-disk schema
 * shape via `validateSavedWorkspace`.  If a future change drops one of
 * these fields, the assertions below fire before the user does.
 */
import { describe, it, expect } from "vitest";
import {
  SAVED_WORKSPACE_VERSION,
  validateSavedWorkspace,
} from "../types/session";

describe("SavedWorkspace v2", () => {
  it("declares schema version 2", () => {
    expect(SAVED_WORKSPACE_VERSION).toBe(2);
  });

  it("preserves agent-mode fields when present", () => {
    const blob = {
      version: 2,
      sessions: [
        {
          id: "sess-1",
          label: "ira-site",
          description: "",
          color: "#abc",
          group: null,
          working_directory: "/Users/a/projects/ira-site",
          ai_provider: "claude",
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: ["p1"],
          ssh_info: null,
          mode: "agent",
          claude_session_uuid: "8ba2584f-6a3d-4949-904c-ea803d6148c4",
          agent_model: "haiku",
          agent_permission_mode: "plan",
          agent_effort: "medium",
          agent_add_dirs: ["/Users/a/projects/extra"],
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: "sess-1",
    };
    const out = validateSavedWorkspace(blob);
    expect(out).not.toBeNull();
    const s = out!.sessions[0];
    expect(s.mode).toBe("agent");
    expect(s.claude_session_uuid).toBe("8ba2584f-6a3d-4949-904c-ea803d6148c4");
    expect(s.agent_model).toBe("haiku");
    expect(s.agent_permission_mode).toBe("plan");
    expect(s.agent_effort).toBe("medium");
    expect(s.agent_add_dirs).toEqual(["/Users/a/projects/extra"]);
  });

  it("strips invalid types on agent fields rather than rejecting the workspace", () => {
    // A legacy or corrupted save with the wrong type for an agent field
    // should drop the field, not invalidate the entire workspace — losing
    // some agent state is recoverable, losing the whole workspace isn't.
    const blob = {
      version: 2,
      sessions: [
        {
          id: "sess-1",
          label: "x",
          description: "",
          color: "",
          group: null,
          working_directory: "/tmp",
          ai_provider: "claude",
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: [],
          mode: "agent",
          claude_session_uuid: 12345,            // wrong type — drop
          agent_model: { foo: "bar" },           // wrong type — drop
          agent_permission_mode: "plan",         // ok — keep
          agent_add_dirs: "not an array",        // wrong type — drop
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };
    const out = validateSavedWorkspace(blob);
    expect(out).not.toBeNull();
    const s = out!.sessions[0] as Record<string, unknown>;
    expect(s.claude_session_uuid).toBeUndefined();
    expect(s.agent_model).toBeUndefined();
    expect(s.agent_permission_mode).toBe("plan");
    expect(s.agent_add_dirs).toBeUndefined();
  });

  it("accepts a v1 workspace without agent fields (backward compat)", () => {
    // An older save (v1) shouldn't break.  Defaults to terminal mode if
    // `mode` is missing; agent-fields just stay undefined.
    const blob = {
      version: 1,
      sessions: [
        {
          id: "sess-old",
          label: "legacy",
          description: "",
          color: "",
          group: null,
          working_directory: "/tmp",
          ai_provider: null,
          auto_approve: false,
          permission_mode: "default",
          custom_prefix: "",
          custom_suffix: "",
          project_ids: [],
          // no mode — should default to "terminal"
          // no claude_session_uuid — should stay undefined
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: null,
    };
    const out = validateSavedWorkspace(blob);
    expect(out).not.toBeNull();
    expect(out!.sessions[0].mode).toBe("terminal");
    expect(out!.sessions[0].claude_session_uuid).toBeUndefined();
  });
});
