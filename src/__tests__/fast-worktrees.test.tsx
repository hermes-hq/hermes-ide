// @vitest-environment jsdom
/**
 * N17 — fast worktrees (frontend side).
 *
 * Covers, with the Tauri bridge mocked:
 * - while the "diskGuard" flag is on, a new or reused worktree is prepared
 *   (dependencies cloned, ports given) right after it is made and before
 *   the call returns, so the session's terminal starts with them; with the
 *   flag off nothing is prepared
 * - a failed preparation never fails worktree creation
 * - the session's Git panel shows the ports and, per folder, whether it was
 *   cloned or why it must be installed as usual
 *
 * The cloning, lockfile matching and port picking are covered in
 * src-tauri/src/git/{cow_clone,fast_setup}.rs, and the whole journey on the
 * real app in e2e/app/scenarios/N17-fast-worktrees.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));

import { createWorktree, attachWorktree } from "../api/git";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import { SessionGitPanel } from "../components/SessionGitPanel";
import { describeDependency } from "../components/WorktreeSetupSummary";
import type { DependencySetup, WorktreeSetup } from "../types/git";

async function setFlag(on: boolean) {
  __resetFeatureFlagsForTest();
  await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ diskGuard: on }) });
}

const SETUP: WorktreeSetup = {
  ports: { base: 21010, count: 10 },
  millis: 420,
  dependencies: [
    {
      folder: "node_modules",
      kind: "dependencies",
      lockfiles: ["package-lock.json"],
      status: "cloned",
      method: "clonefile",
      source: "/srv/n17/demo-repo",
      millis: 380,
    },
    {
      folder: "src-tauri/target",
      kind: "build cache",
      lockfiles: ["Cargo.lock"],
      status: "lockfile_changed",
      millis: 2,
    },
  ],
};

beforeEach(() => {
  h.invoke.mockReset();
});

afterEach(() => {
  cleanup();
  __resetFeatureFlagsForTest();
});

describe("N17 worktrees are prepared while the flag is on", () => {
  it("prepares a new worktree after creating it, before returning", async () => {
    await setFlag(true);
    const order: string[] = [];
    h.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === "git_create_worktree") return { worktreePath: "/wt", branchName: "feat", isMainWorktree: false };
      if (cmd === "git_prepare_worktree") return SETUP;
      return undefined;
    });
    const result = await createWorktree("s1", "p1", "feat", true);
    expect(order).toEqual(["git_create_worktree", "git_prepare_worktree"]);
    expect(h.invoke).toHaveBeenCalledWith("git_prepare_worktree", { sessionId: "s1", projectId: "p1" });
    expect(result.worktreePath).toBe("/wt");
  });

  it("prepares a reused checkout too (it gets its own ports)", async () => {
    await setFlag(true);
    h.invoke.mockResolvedValue({ worktreePath: "/wt", branchName: "feat", isMainWorktree: false });
    await attachWorktree("s2", "p1", "feat");
    expect(h.invoke.mock.calls.map((c) => c[0])).toEqual(["git_attach_worktree", "git_prepare_worktree"]);
  });

  it("prepares nothing while the flag is off", async () => {
    await setFlag(false);
    h.invoke.mockResolvedValue({ worktreePath: "/wt", branchName: "feat", isMainWorktree: false });
    await createWorktree("s1", "p1", "feat", true);
    await attachWorktree("s2", "p1", "feat");
    expect(h.invoke.mock.calls.map((c) => c[0])).toEqual(["git_create_worktree", "git_attach_worktree"]);
  });

  it("a failed preparation does not fail the worktree", async () => {
    await setFlag(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "git_prepare_worktree") throw new Error("disk exploded");
      return { worktreePath: "/wt", branchName: "feat", isMainWorktree: false };
    });
    await expect(createWorktree("s1", "p1", "feat", true)).resolves.toMatchObject({ worktreePath: "/wt" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a failed creation is not prepared", async () => {
    await setFlag(true);
    h.invoke.mockRejectedValue(new Error("branch in use"));
    await expect(createWorktree("s1", "p1", "feat", true)).rejects.toThrow("branch in use");
    expect(h.invoke.mock.calls.map((c) => c[0])).toEqual(["git_create_worktree"]);
  });
});

describe("N17 the session's Git panel shows what was prepared", () => {
  function backend(setup?: WorktreeSetup) {
    h.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_status") {
        return {
          timestamp: 1,
          projects: [
            {
              project_id: "p1",
              project_name: "demo-repo",
              project_path: "/srv/n17/wt",
              is_git_repo: true,
              branch: "feat",
              remote_branch: null,
              ahead: 0,
              behind: 0,
              files: [],
              has_conflicts: false,
              stash_count: 0,
              error: null,
            },
          ],
        };
      }
      if (cmd === "git_session_worktree_info") {
        if (args?.projectId !== "p1") return null;
        return {
          id: "r1",
          sessionId: "s1",
          projectId: "p1",
          worktreePath: "/wt",
          branchName: "feat",
          isMainWorktree: false,
          createdAt: "",
          ...(setup ? { setup } : {}),
        };
      }
      if (cmd === "get_settings") return {};
      return undefined;
    });
  }

  it("lists the ports and each folder's outcome", async () => {
    await setFlag(true);
    backend(SETUP);
    const { container } = render(<SessionGitPanel sessionId="s1" projectId="" />);
    await screen.findByText("Ports 21010–21019 (PORT=21010)");
    await screen.findByText(
      "node_modules: cloned from demo-repo in 0.4 s, sharing disk space until changed",
    );
    await screen.findByText(
      "src-tauri/target: Cargo.lock differs from every other checkout. Install build cache as usual",
    );
    const rows = [...container.querySelectorAll(".worktree-setup-dep")].map((el) => (el as HTMLElement).dataset.status);
    expect(rows).toEqual(["cloned", "lockfile_changed"]);
  });

  it("shows nothing for a worktree that was never prepared, or with the flag off", async () => {
    await setFlag(true);
    backend(undefined);
    const first = render(<SessionGitPanel sessionId="s1" projectId="" />);
    await screen.findByText("GIT");
    await Promise.resolve();
    expect(first.container.querySelector(".worktree-setup")).toBeNull();
    first.unmount();

    await setFlag(false);
    backend(SETUP);
    const second = render(<SessionGitPanel sessionId="s1" projectId="" />);
    await screen.findByText("GIT");
    await new Promise((r) => setTimeout(r, 20));
    expect(second.container.querySelector(".worktree-setup")).toBeNull();
  });
});

describe("N17 describeDependency", () => {
  const base: DependencySetup = {
    folder: "node_modules",
    kind: "dependencies",
    lockfiles: ["package-lock.json"],
    status: "cloned",
    millis: 1234,
  };

  it.each<[Partial<DependencySetup>, string]>([
    [{ status: "cloned", source: "C:\\work\\demo" }, "node_modules: cloned from demo in 1.2 s, sharing disk space until changed"],
    [{ status: "already_there" }, "node_modules: already in this worktree"],
    [{ status: "not_installed_elsewhere" }, "node_modules: not installed in any other checkout yet. Install dependencies as usual"],
    [
      { status: "copy_on_write_unavailable", detail: "this disk does not support copy-on-write clones (btrfs or XFS needed)" },
      "node_modules: not cloned, this disk does not support copy-on-write clones (btrfs or XFS needed). Install dependencies as usual",
    ],
    [{ status: "failed", detail: "permission denied" }, "node_modules: could not be cloned (permission denied). Install dependencies as usual"],
  ])("%j", (patch, text) => {
    expect(describeDependency({ ...base, ...patch })).toBe(text);
  });
});
