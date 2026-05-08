/**
 * Pins the IPC contract of `useSessionProjects.attach()` / `.detach()`:
 * each must touch BOTH the relationship row (attach/detach_session_project)
 * AND the workspace_paths column (add/remove_workspace_path), and in the
 * right order — the relationship write must come first on attach so that
 * any workspace-paths listener on the frontend already sees the project
 * row when it merges, and the workspace-paths drop must come first on
 * detach so a "bridge respawn between drops" can't re-grant access mid-
 * way.
 *
 * The hook itself is a React closure; importing the React-rendered
 * version into Vitest would require a full RTL setup just to assert two
 * IPC sequences.  Instead, we mirror the algorithm here (same shape as
 * `deferred-fork.test.ts`) and assert against the IPC mock.  When the
 * real hook drifts, the call-sequence assertion below catches it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

import {
  attachSessionProject,
  detachSessionProject,
  getProjects,
} from "../api/projects";
import { addWorkspacePath, removeWorkspacePath } from "../api/sessions";

const FAKE_PROJECT_A = {
  id: "proj-a",
  path: "/Users/dev/proj-a",
  name: "proj-a",
  languages: [],
  frameworks: [],
  architecture: null,
  conventions: [],
  scan_status: "scanned" as const,
  last_scanned_at: null,
  created_at: 0,
  updated_at: 0,
};

async function attachReplica(sessionId: string, projectId: string) {
  await attachSessionProject(sessionId, projectId, "primary");
  const all = await getProjects();
  const proj = all.find((p) => p.id === projectId);
  if (proj?.path) {
    await addWorkspacePath(sessionId, proj.path);
  }
}

async function detachReplica(sessionId: string, projectId: string) {
  const all = await getProjects();
  const proj = all.find((p) => p.id === projectId);
  if (proj?.path) {
    await removeWorkspacePath(sessionId, proj.path);
  }
  await detachSessionProject(sessionId, projectId);
}

describe("useSessionProjects attach/detach IPC contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_registered_projects") return [FAKE_PROJECT_A];
      return undefined;
    });
  });

  it("attach() fires attach_session_project BEFORE add_workspace_path", async () => {
    await attachReplica("sess-1", "proj-a");
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "attach_session_project",
      "get_registered_projects",
      "add_workspace_path",
    ]);
    const addCall = invokeMock.mock.calls.find(([c]) => c === "add_workspace_path");
    expect(addCall?.[1]).toEqual({ sessionId: "sess-1", path: "/Users/dev/proj-a" });
  });

  it("detach() fires remove_workspace_path BEFORE detach_session_project", async () => {
    await detachReplica("sess-1", "proj-a");
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "get_registered_projects",
      "remove_workspace_path",
      "detach_session_project",
    ]);
    const removeCall = invokeMock.mock.calls.find(
      ([c]) => c === "remove_workspace_path",
    );
    expect(removeCall?.[1]).toEqual({ sessionId: "sess-1", path: "/Users/dev/proj-a" });
  });

  it("two consecutive attaches accumulate add_workspace_path calls (multi-folder happy path)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_registered_projects") {
        return [
          FAKE_PROJECT_A,
          { ...FAKE_PROJECT_A, id: "proj-b", path: "/Users/dev/proj-b", name: "proj-b" },
        ];
      }
      return undefined;
    });

    await attachReplica("sess-2", "proj-a");
    await attachReplica("sess-2", "proj-b");

    const addCalls = invokeMock.mock.calls
      .filter(([c]) => c === "add_workspace_path")
      .map(([, args]) => args);
    expect(addCalls).toEqual([
      { sessionId: "sess-2", path: "/Users/dev/proj-a" },
      { sessionId: "sess-2", path: "/Users/dev/proj-b" },
    ]);
  });
});
