/**
 * Workbench layout and per-session notes must survive the saved-workspace
 * round trip: save shape -> JSON -> validateSavedWorkspace -> loaders.
 * validateSavedWorkspace used to rebuild the object without these two
 * fields, so they never came back after a restart.
 */
import { describe, it, expect } from "vitest";

import { validateSavedWorkspace, SAVED_WORKSPACE_VERSION, type SavedWorkspace } from "../types/session";
import {
  loadNotesMap,
  loadWorkbenchLayout,
  serializeNotesMap,
  serializeWorkbenchLayout,
  DEFAULT_PERSISTED_WORKBENCH,
  type PersistedWorkbenchLayout,
} from "../utils/workbenchLayout";

const session = {
  id: "sess-a",
  label: "Agent A",
  description: "",
  color: "",
  group: null,
  working_directory: "/work/test/project",
  ai_provider: "claude",
  auto_approve: false,
  permission_mode: "default",
  custom_prefix: "",
  custom_suffix: "",
  project_ids: [],
  mode: "agent" as const,
};

/** What saveWorkspace writes, then what the next launch reads back. */
function roundTrip(layout: PersistedWorkbenchLayout, notes: Record<string, string>) {
  const saved: SavedWorkspace = {
    version: SAVED_WORKSPACE_VERSION,
    sessions: [session],
    layout: null,
    focused_pane_id: null,
    active_session_id: "sess-a",
    workbench: serializeWorkbenchLayout(layout),
    notes: serializeNotesMap(notes),
  };
  const restored = validateSavedWorkspace(JSON.parse(JSON.stringify(saved)));
  expect(restored).not.toBeNull();
  return {
    layout: loadWorkbenchLayout(restored!.workbench),
    notes: loadNotesMap(restored!.notes),
  };
}

describe("workbench restore", () => {
  it("brings back a non-default workbench layout", () => {
    const layout: PersistedWorkbenchLayout = { open: false, tab: "git", ratio: 0.33, filesNotesSplit: 0.4 };
    expect(roundTrip(layout, {}).layout).toEqual(layout);
  });

  it("brings back each session's notes", () => {
    const notes = { "sess-a": "remember: run the migration\nthen deploy", "sess-b": "second session" };
    expect(roundTrip(DEFAULT_PERSISTED_WORKBENCH, notes).notes).toEqual(notes);
  });

  it("keeps workbench and notes when upgrading an older-version save", () => {
    const restored = validateSavedWorkspace({
      version: 1,
      sessions: [{ id: "old", label: "Old" }],
      layout: null,
      workbench: { open: true, tab: "context", ratio: 0.6, filesNotesSplit: 0.8 },
      notes: { old: "kept" },
    });
    expect(loadWorkbenchLayout(restored!.workbench)).toEqual({
      open: true,
      tab: "context",
      ratio: 0.6,
      filesNotesSplit: 0.8,
    });
    expect(loadNotesMap(restored!.notes)).toEqual({ old: "kept" });
  });

  it("falls back to defaults when the fields are missing or malformed", () => {
    const base = { sessions: [{ id: "s", label: "S" }], layout: null };
    for (const extra of [{}, { workbench: "nope", notes: ["x"] }, { workbench: null, notes: null }]) {
      const restored = validateSavedWorkspace({ ...base, ...extra });
      expect(restored).not.toBeNull();
      expect(loadWorkbenchLayout(restored!.workbench)).toEqual(DEFAULT_PERSISTED_WORKBENCH);
      expect(loadNotesMap(restored!.notes)).toEqual({});
    }
  });
});
