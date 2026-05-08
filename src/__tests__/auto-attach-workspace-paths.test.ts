/**
 * Auto-attach on cwd change must fold the project path into
 * `workspace_paths` for AGENT-mode sessions, so the SDK is respawned with
 * `additionalDirectories` covering everything the user can see in the
 * Context Panel.
 *
 * Bug repro: until 1.0.0 the auto-attach branch only wrote a
 * `session_realms` row.  An agent-mode session whose cwd was inside a
 * known project showed the project as attached, but Claude was spawned
 * with `additionalDirectories: []` — its file tools refused every read.
 *
 * Terminal-mode parity check is here too: PTY sessions inherit cwd
 * directly and never need `--add-dir`, so `addWorkspacePath` MUST NOT be
 * called for terminal sessions (regression guard for the user's "the old
 * one works" rule).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoAttachInsideProject } from "../utils/autoAttach";

type Project = { id: string; path: string };

function makeDeps(opts: {
  projects: Project[];
  alreadyAttached?: string[];
}) {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    getProjects: vi.fn(async () => {
      calls.push(["getProjects"]);
      return opts.projects;
    }),
    getSessionProjects: vi.fn(async (sid: string) => {
      calls.push(["getSessionProjects", sid]);
      const attached = opts.alreadyAttached ?? [];
      return opts.projects.filter((p) => attached.includes(p.id));
    }),
    attachSessionProject: vi.fn(async (sid: string, pid: string, role: string) => {
      calls.push(["attachSessionProject", sid, pid, role]);
    }),
    addWorkspacePath: vi.fn(async (sid: string, path: string) => {
      calls.push(["addWorkspacePath", sid, path]);
    }),
  };
}

describe("autoAttachInsideProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agent session whose cwd is inside a known project: attaches AND folds path into workspace_paths", async () => {
    const deps = makeDeps({
      projects: [{ id: "proj-a", path: "/Users/dev/proj-a" }],
    });
    await autoAttachInsideProject(
      { id: "sess-1", mode: "agent", working_directory: "/Users/dev/proj-a/src" },
      deps,
    );

    expect(deps.attachSessionProject).toHaveBeenCalledTimes(1);
    expect(deps.attachSessionProject).toHaveBeenCalledWith("sess-1", "proj-a", "primary");
    expect(deps.addWorkspacePath).toHaveBeenCalledTimes(1);
    expect(deps.addWorkspacePath).toHaveBeenCalledWith("sess-1", "/Users/dev/proj-a");
    // Order matters — relationship row before SDK respawn signal.
    const sequence = deps.calls.map((c) => c[0]);
    expect(sequence).toEqual([
      "getProjects",
      "getSessionProjects",
      "attachSessionProject",
      "addWorkspacePath",
    ]);
  });

  it("agent session whose cwd EXACTLY equals a project path: attaches and folds", async () => {
    const deps = makeDeps({
      projects: [{ id: "proj-a", path: "/Users/dev/proj-a" }],
    });
    await autoAttachInsideProject(
      { id: "sess-1", mode: "agent", working_directory: "/Users/dev/proj-a" },
      deps,
    );
    expect(deps.attachSessionProject).toHaveBeenCalledOnce();
    expect(deps.addWorkspacePath).toHaveBeenCalledWith("sess-1", "/Users/dev/proj-a");
  });

  it("terminal session: only attaches, NEVER folds (regression guard for old logic)", async () => {
    const deps = makeDeps({
      projects: [{ id: "proj-a", path: "/Users/dev/proj-a" }],
    });
    await autoAttachInsideProject(
      { id: "sess-2", mode: "terminal", working_directory: "/Users/dev/proj-a/src" },
      deps,
    );
    expect(deps.attachSessionProject).toHaveBeenCalledOnce();
    expect(deps.addWorkspacePath).not.toHaveBeenCalled();
  });

  it("session whose cwd is OUTSIDE every project: no attach, no fold", async () => {
    const deps = makeDeps({
      projects: [{ id: "proj-a", path: "/Users/dev/proj-a" }],
    });
    await autoAttachInsideProject(
      { id: "sess-3", mode: "agent", working_directory: "/tmp/scratch" },
      deps,
    );
    expect(deps.getSessionProjects).not.toHaveBeenCalled();
    expect(deps.attachSessionProject).not.toHaveBeenCalled();
    expect(deps.addWorkspacePath).not.toHaveBeenCalled();
  });

  it("session already attached to the project: skips both attach and fold (idempotent)", async () => {
    const deps = makeDeps({
      projects: [{ id: "proj-a", path: "/Users/dev/proj-a" }],
      alreadyAttached: ["proj-a"],
    });
    await autoAttachInsideProject(
      { id: "sess-4", mode: "agent", working_directory: "/Users/dev/proj-a/src" },
      deps,
    );
    expect(deps.attachSessionProject).not.toHaveBeenCalled();
    expect(deps.addWorkspacePath).not.toHaveBeenCalled();
  });

  it("path-prefix collision is rejected (proj-a must not match proj-a-legacy)", async () => {
    const deps = makeDeps({
      projects: [
        { id: "proj-a", path: "/Users/dev/proj-a" },
        { id: "proj-legacy", path: "/Users/dev/proj-a-legacy" },
      ],
    });
    await autoAttachInsideProject(
      { id: "sess-5", mode: "agent", working_directory: "/Users/dev/proj-a-legacy/src" },
      deps,
    );
    expect(deps.attachSessionProject).toHaveBeenCalledWith("sess-5", "proj-legacy", "primary");
    expect(deps.addWorkspacePath).toHaveBeenCalledWith("sess-5", "/Users/dev/proj-a-legacy");
  });

  it("first-match wins; second matching project is ignored", async () => {
    const deps = makeDeps({
      projects: [
        { id: "outer", path: "/Users/dev" },
        { id: "inner", path: "/Users/dev/proj-a" },
      ],
    });
    await autoAttachInsideProject(
      { id: "sess-6", mode: "agent", working_directory: "/Users/dev/proj-a/src" },
      deps,
    );
    // First project in the list (outer) matches the prefix; we attach to that
    // and stop.  The behaviour is deterministic on the order returned by
    // getProjects(), which is what the original auto-attach loop guaranteed.
    expect(deps.attachSessionProject).toHaveBeenCalledTimes(1);
    expect(deps.attachSessionProject).toHaveBeenCalledWith("sess-6", "outer", "primary");
  });

  it("missing working_directory: short-circuit (no IPCs)", async () => {
    const deps = makeDeps({ projects: [{ id: "p", path: "/x" }] });
    await autoAttachInsideProject(
      { id: "sess-7", mode: "agent", working_directory: null },
      deps,
    );
    expect(deps.getProjects).not.toHaveBeenCalled();
  });
});
