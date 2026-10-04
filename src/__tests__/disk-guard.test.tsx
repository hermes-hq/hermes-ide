// @vitest-environment jsdom
/**
 * N14 — disk guard and worktree hygiene (frontend side).
 *
 * Covers, with the Tauri bridge mocked:
 * - worktree creation asks the backend to enforce the 10 GB guard only
 *   while the "diskGuard" flag is on
 * - a low-disk refusal reaches the person as a clear toast, without the
 *   internal project id
 * - the Worktrees view, flag on: free space, disk used per worktree (with
 *   its build output), "Remove build output" frees it and the size shown
 *   drops, and "Remove all orphans" sweeps every listed orphan in one action
 * - flag off: none of that appears and the old commands are used
 *
 * The Rust side (free space, the refusal, what counts as build output, the
 * sweep's safety checks) is covered in src-tauri/src/git/disk_guard.rs, and
 * the whole journey on the real app in e2e/app/scenarios/N14-disk-guard.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));

import { createWorktree } from "../api/git";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import { worktreeErrorToastMessage } from "../hooks/useWorktreeErrorToasts";
import { WorktreeOverviewPanel, formatDiskBytes } from "../components/WorktreeOverviewPanel";
import { SessionGitPanel } from "../components/SessionGitPanel";
import type { OrphanWorktree, WorktreeOverviewEntry, WorktreeUsage } from "../types/git";

async function setDiskGuardFlag(on: boolean) {
  __resetFeatureFlagsForTest();
  await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ diskGuard: on }) });
}

const WT_PATH = "/srv/n14/data/hermes-worktrees/0123456789abcdef/aaaaaaaa_feature";
const ORPHAN_A = "/srv/n14/data/hermes-worktrees/0123456789abcdef/bbbbbbbb_old";
const ORPHAN_B = "/srv/n14/data/hermes-worktrees/fedcba9876543210/cccccccc_gone";

function worktreeEntry(): WorktreeOverviewEntry {
  return {
    worktree_path: WT_PATH,
    branch_name: "feature",
    session_id: "aaaaaaaa-1111",
    session_label: "Session A",
    project_id: "p1",
    project_name: "demo",
    root_path: "/srv/n14/demo",
    is_main_worktree: false,
    created_at: new Date().toISOString(),
    last_activity_at: null,
  };
}

/** A fake backend with real state: reclaim and sweep change what later calls return. */
function fakeBackend(detected: OrphanWorktree[] = []) {
  const usage: Record<string, WorktreeUsage> = {
    [WT_PATH]: { path: WT_PATH, total_bytes: 12_400_000, build_output_bytes: 12_000_000 },
    [ORPHAN_A]: { path: ORPHAN_A, total_bytes: 3_000_000, build_output_bytes: 0 },
    [ORPHAN_B]: { path: ORPHAN_B, total_bytes: 2_000_000, build_output_bytes: 0 },
  };
  let orphans = [
    { worktree_path: ORPHAN_A, repo_path: "/srv/n14/demo", repo_exists: true, branch_hint: "old" },
    { worktree_path: ORPHAN_B, repo_path: "/srv/n14/gone", repo_exists: false, branch_hint: "gone" },
  ];
  const calls: string[] = [];
  h.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    switch (cmd) {
      case "git_list_all_worktrees":
        return [worktreeEntry()];
      case "git_list_orphan_folders":
        return orphans;
      case "git_detect_orphan_worktrees":
        return detected;
      case "git_cleanup_orphan_worktrees": {
        const paths = args!.paths as string[];
        detected = detected.filter((o) => !paths.includes(o.worktree_path));
        return paths.map((p) => ({ path: p, success: true, error: null }));
      }
      case "git_disk_status":
        return { free_bytes: 42_100_000_000, required_bytes: 10_000_000_000, below_threshold: false };
      case "git_worktree_usage":
        return usage[args!.worktreePath as string];
      case "git_reclaim_build_output": {
        const p = args!.worktreePath as string;
        const freed = usage[p].build_output_bytes;
        usage[p] = { path: p, total_bytes: usage[p].total_bytes - freed, build_output_bytes: 0 };
        return { path: p, removed: ["node_modules", "target"], freed_bytes: freed, failed: [] };
      }
      case "git_sweep_orphan_folders": {
        const paths = args!.paths as string[];
        orphans = orphans.filter((o) => !paths.includes(o.worktree_path));
        return paths.map((p) => ({ path: p, removed: true, freed_bytes: usage[p].total_bytes, error: null }));
      }
      default:
        return undefined;
    }
  });
  return { calls };
}

beforeEach(() => {
  h.invoke.mockReset();
});

afterEach(() => {
  cleanup();
  __resetFeatureFlagsForTest();
});

describe("N14 createWorktree and the disk guard flag", () => {
  it("asks the backend to enforce the guard while the flag is on", async () => {
    await setDiskGuardFlag(true);
    h.invoke.mockResolvedValue({});
    await createWorktree("s1", "p1", "feat", true);
    expect(h.invoke).toHaveBeenCalledWith("git_create_worktree", expect.objectContaining({ enforceDiskGuard: true }));
  });

  it("leaves the request unchanged while the flag is off", async () => {
    await setDiskGuardFlag(false);
    h.invoke.mockResolvedValue({});
    await createWorktree("s1", "p1", "feat", true);
    const args = h.invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("enforceDiskGuard");
  });
});

describe("N14 low-disk refusal toast", () => {
  const refusal =
    "Not enough free disk space: 4.2 GB free, 10.0 GB needed to create a worktree. Nothing was created. Free up space (Settings > Storage shows what can go without losing work), then try again.";

  it("shows the reason without the project id when the session was not created", () => {
    const msg = worktreeErrorToastMessage([`0f8a-project-id: ${refusal}`], true);
    expect(msg).toBe(`Session was not created. ${refusal}`);
    expect(msg).not.toContain("0f8a-project-id");
  });

  it("keeps the generic text for other failures", () => {
    const msg = worktreeErrorToastMessage(["p1: git worktree add failed: boom"], true);
    expect(msg).toContain("could not create a worktree");
    expect(msg).toContain("boom");
  });
});

describe("N14 formatDiskBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [12_400_000, "12.4 MB"],
    [4_200_000_000, "4.2 GB"],
    [10_000_000_000, "10.0 GB"],
    [250_000_000_000, "250 GB"],
  ])("%d -> %s", (bytes, text) => {
    expect(formatDiskBytes(bytes)).toBe(text);
  });
});

describe("N14 Worktrees view with the flag on", () => {
  it("shows free space and the disk each worktree uses, including build output", async () => {
    await setDiskGuardFlag(true);
    fakeBackend();
    const { container } = render(<WorktreeOverviewPanel />);
    await screen.findByText("Free disk space: 42.1 GB");
    await screen.findByText("12.4 MB (build output 12.0 MB)");
    await screen.findByText("3.0 MB");
    await screen.findByText("2.0 MB");
    expect(container.querySelectorAll(".worktree-overview-orphan")).toHaveLength(2);
  });

  it("removes build output on request and the size shown drops", async () => {
    await setDiskGuardFlag(true);
    const { calls } = fakeBackend();
    render(<WorktreeOverviewPanel />);
    const button = await screen.findByText("Remove build output");
    fireEvent.click(button);
    await screen.findByText("Removed node_modules, target from feature: freed 12.0 MB.");
    await screen.findByText("400 KB");
    expect(screen.queryByText("Remove build output")).toBeNull();
    expect(calls.filter((c) => c === "git_reclaim_build_output")).toHaveLength(1);
  });

  it("removes every orphan in one action after one confirmation", async () => {
    await setDiskGuardFlag(true);
    const { calls } = fakeBackend();
    const { container } = render(<WorktreeOverviewPanel />);
    const sweep = await screen.findByText("Remove all orphans (2, 5.0 MB)");
    fireEvent.click(sweep);
    expect(calls).not.toContain("git_sweep_orphan_folders");
    fireEvent.click(await screen.findByText("Delete 2 working copies"));
    await screen.findByText("Removed 2 orphaned folders: freed 5.0 MB.");
    const sweepCall = h.invoke.mock.calls.find(([cmd]) => cmd === "git_sweep_orphan_folders");
    expect((sweepCall![1] as { paths: string[] }).paths.sort()).toEqual([ORPHAN_A, ORPHAN_B].sort());
    await waitFor(() => expect(container.querySelectorAll(".worktree-overview-orphan")).toHaveLength(0));
    expect(calls).not.toContain("git_cleanup_orphan_worktrees");
  });
});

describe("N14 Worktrees view lists records whose folder is gone", () => {
  const RECORD = "/srv/n14/data/hermes-worktrees/0123456789abcdef/dddddddd_lost";

  it("shows them next to the orphaned folders and clears them with the same action", async () => {
    await setDiskGuardFlag(true);
    const { calls } = fakeBackend([
      { worktree_path: RECORD, branch_name: "lost", kind: "record_only", root_path: "/srv/n14/demo", session_id: "dddddddd-4444" },
      // Already in the folder scan: must not be listed twice.
      { worktree_path: ORPHAN_A, branch_name: "old", kind: "directory_only", root_path: "/srv/n14/demo", session_id: null },
    ]);
    const { container } = render(<WorktreeOverviewPanel />);
    await screen.findByText("Missing directory");
    expect(container.querySelectorAll(".worktree-overview-orphan")).toHaveLength(3);

    fireEvent.click(await screen.findByText("Remove all orphans (3, 5.0 MB)"));
    fireEvent.click(await screen.findByText("Delete 3 working copies"));
    await screen.findByText("Removed 2 orphaned folders: freed 5.0 MB. Cleared 1 record of working copies already deleted.");
    const sweepCall = h.invoke.mock.calls.find(([cmd]) => cmd === "git_sweep_orphan_folders");
    expect((sweepCall![1] as { paths: string[] }).paths.sort()).toEqual([ORPHAN_A, ORPHAN_B].sort());
    const cleanupCall = h.invoke.mock.calls.find(([cmd]) => cmd === "git_cleanup_orphan_worktrees");
    expect((cleanupCall![1] as { paths: string[] }).paths).toEqual([RECORD]);
    await waitFor(() => expect(container.querySelectorAll(".worktree-overview-orphan")).toHaveLength(0));
    expect(calls).toContain("git_list_orphan_folders");
  });
});

describe("N14 Worktrees view with the flag off", () => {
  it("shows none of the disk guard and uses the old orphan detection", async () => {
    await setDiskGuardFlag(false);
    const { calls } = fakeBackend();
    render(<WorktreeOverviewPanel />);
    await screen.findByText("feature");
    expect(screen.queryByText(/Free disk space/)).toBeNull();
    expect(screen.queryByText("Remove build output")).toBeNull();
    expect(screen.queryByText(/Remove all orphans/)).toBeNull();
    expect(calls).toContain("git_detect_orphan_worktrees");
    expect(calls).not.toContain("git_list_orphan_folders");
    expect(calls).not.toContain("git_worktree_usage");
  });
});

describe("N14 the session Git panel (terminal sessions) reaches the Worktrees view", () => {
  it("offers a Worktrees view only while the flag is on", async () => {
    await setDiskGuardFlag(true);
    fakeBackend();
    const on = render(<SessionGitPanel sessionId="s1" projectId="" />);
    fireEvent.click(await screen.findByText("Worktrees"));
    await screen.findByText("Free disk space: 42.1 GB");
    on.unmount();

    await setDiskGuardFlag(false);
    fakeBackend();
    render(<SessionGitPanel sessionId="s1" projectId="" />);
    await screen.findByText("GIT");
    expect(screen.queryByText("Worktrees")).toBeNull();
  });
});
