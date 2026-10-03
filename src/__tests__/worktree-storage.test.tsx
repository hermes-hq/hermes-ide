// @vitest-environment jsdom
/**
 * Keep old worktrees from filling the disk — Settings > Storage and the
 * background pass's notices (frontend side), with the Tauri bridge mocked.
 *
 * Safety rules as the person sees them:
 * - an open session's worktree offers no action at all
 * - a worktree with changes or unpushed commits is never removed in one
 *   click: "Remove…" asks first and says a backup is saved
 * - a folder whose repo is gone says no backup is possible and only goes
 *   with an explicit "Delete for good" (allowUnrecoverable)
 * - merged-and-clean and orphaned-and-clean worktrees remove in one click
 * - build output removal is offered wherever there is build output, except
 *   on an open session's worktree
 * - "Clean up now" runs the automatic rules and says what it freed
 *
 * The rules themselves are tested in src-tauri/src/git/hygiene.rs and on
 * the real app in e2e/app/scenarios/N14-storage-hygiene.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { StorageSettings as RawStorageSettings } from "../components/StorageSettings";
import { I18nProvider } from "../i18n/I18nProvider";
import { storageNoticeToast } from "../hooks/useWorktreeStorageNotices";
import {
  daysSince, formatStorageBytes, groupByRepo,
  type StorageReport, type StorageWorktree,
} from "../api/worktreeStorage";

const GB = 1_000_000_000;
const DAY = 86_400_000;

function wt(over: Partial<StorageWorktree> & { path: string }): StorageWorktree {
  return {
    repoPath: "/srv/repo/app",
    repoName: "app",
    repoExists: true,
    branch: "feature",
    sessionIds: ["s1"],
    state: "idle",
    autoAction: "none",
    needs: null,
    backupBeforeRemoval: false,
    facts: { gitKnows: true, branch: "feature", detached: false, changedFiles: 0, unpushedCommits: 0, merged: false },
    lastUsed: new Date(Date.now() - 20 * DAY).toISOString(),
    totalBytes: 2 * GB,
    buildOutputBytes: 0,
    autoBytes: 0,
    ...over,
  };
}

const OPEN = wt({ path: "/d/hermes-worktrees/a/1_open", branch: "open-work", state: "open", buildOutputBytes: 5 * GB, totalBytes: 6 * GB, lastUsed: new Date().toISOString() });
const DIRTY = wt({
  path: "/d/hermes-worktrees/a/2_dirty", branch: "dirty-work", needs: "changes", backupBeforeRemoval: true,
  autoAction: "remove_build_output", buildOutputBytes: 3 * GB, totalBytes: 4 * GB, autoBytes: 3 * GB,
  facts: { gitKnows: true, branch: "dirty-work", detached: false, changedFiles: 12, unpushedCommits: 3, merged: false },
});
const LANDED = wt({
  path: "/d/hermes-worktrees/a/3_landed", branch: "landed-work", state: "landed", autoAction: "remove_worktree",
  totalBytes: 8 * GB, autoBytes: 8 * GB, buildOutputBytes: 7 * GB,
  facts: { gitKnows: true, branch: "landed-work", detached: false, changedFiles: 0, unpushedCommits: 0, merged: true },
});
const ORPHAN = wt({ path: "/d/hermes-worktrees/a/4_orphan", branch: "orphan-work", state: "orphaned", sessionIds: [], autoAction: "remove_worktree", autoBytes: 2 * GB });
const GONE = wt({
  path: "/d/hermes-worktrees/b/5_gone", repoPath: "/srv/repo/gone", repoName: "gone", repoExists: false, branch: "gone-work",
  state: "orphaned", sessionIds: [], needs: "repo_gone", facts: { gitKnows: false, branch: null, detached: false, changedFiles: 0, unpushedCommits: 0, merged: false },
});

function report(worktrees: StorageWorktree[]): StorageReport {
  return {
    freeBytes: 15 * GB,
    diskTotalBytes: 500 * GB,
    guardBytes: 10 * GB,
    settings: { autoCleanup: true, idleDays: 7, lowDiskBytes: 20 * GB },
    worktrees,
    totalBytes: worktrees.reduce((a, w) => a + w.totalBytes, 0),
    autoBytes: worktrees.reduce((a, w) => a + w.autoBytes, 0),
    needsBytes: 4 * GB,
    scannedAt: new Date().toISOString(),
  };
}

function routeInvoke(r: StorageReport, extra: Record<string, unknown> = {}) {
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd in extra) return typeof extra[cmd] === "function" ? (extra[cmd] as () => unknown)() : extra[cmd];
    if (cmd === "worktree_storage_report") return r;
    if (cmd === "worktree_storage_backups") return [];
    throw new Error(`unexpected ${cmd}`);
  });
}

function StorageSettings(props: Parameters<typeof RawStorageSettings>[0]) {
  return <I18nProvider><RawStorageSettings {...props} /></I18nProvider>;
}

function row(path: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="storage-row"][data-path="${path}"]`);
  if (!el) throw new Error(`no row ${path}`);
  return el;
}

beforeEach(() => {
  h.invoke.mockReset();
});
afterEach(() => cleanup());

describe("Settings > Storage", () => {
  it("shows free space, totals and what can be freed, grouped by repo", async () => {
    routeInvoke(report([OPEN, DIRTY, LANDED, ORPHAN, GONE]));
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("open-work");
    expect(screen.getByTestId("storage-free").textContent).toBe("15.0 GB free");
    expect(screen.getByTestId("storage-free").className).toContain("storage-free--low");
    expect(screen.getByTestId("storage-total").textContent).toBe("22.0 GB");
    expect(screen.getByTestId("storage-auto").textContent).toBe("13.0 GB can be freed automatically");
    expect(screen.getByTestId("storage-needs").textContent).toContain("4.0 GB needs you");
    const repos = screen.getAllByTestId("storage-repo");
    expect(repos).toHaveLength(2);
    expect(repos[0].textContent).toContain("app");
    expect(repos[0].textContent).toContain("4 worktrees");
    expect(repos[1].textContent).toContain("1 worktree");
  });

  it("an open session's worktree offers no action, even with build output", async () => {
    routeInvoke(report([OPEN]));
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("open-work");
    const r = row(OPEN.path);
    expect(within(r).getByTestId("storage-state").textContent).toBe("Open");
    expect(r.textContent).toContain("not touched while its session is open");
    expect(within(r).queryByRole("button")).toBeNull();
  });

  it("a worktree with changes asks first and is removed with a backup", async () => {
    routeInvoke(report([DIRTY]), {
      worktree_storage_remove: {
        path: DIRTY.path, removed: true, error: null, freedBytes: 4 * GB,
        backup: { refName: "refs/hermes/backups/20261003-dirty-work", commit: "abc", repoPath: "/srv/repo/app", worktreePath: DIRTY.path, branch: "dirty-work", createdAt: "", restoreCommand: "git branch restored/x refs/hermes/backups/20261003-dirty-work" },
      },
    });
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("dirty-work");
    const r = row(DIRTY.path);
    expect(r.textContent).toContain("12 changed files");
    expect(r.textContent).toContain("3 commits not pushed or merged");
    fireEvent.click(within(r).getByTestId("storage-remove"));
    expect(h.invoke).not.toHaveBeenCalledWith("worktree_storage_remove", expect.anything());
    expect(r.textContent).toContain("saves a backup of its files first");
    fireEvent.click(within(r).getByTestId("storage-confirm-remove"));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("worktree_storage_remove", { path: DIRTY.path, allowUnrecoverable: false }));
    expect((await screen.findByTestId("storage-note")).textContent).toContain("Backup: refs/hermes/backups/20261003-dirty-work");
  });

  it("a folder whose repo is gone needs an explicit 'Delete for good'", async () => {
    routeInvoke(report([GONE]), { worktree_storage_remove: { path: GONE.path, removed: true, error: null, freedBytes: GB, backup: null } });
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("gone-work");
    const r = row(GONE.path);
    expect(r.textContent).toContain("no backup possible");
    fireEvent.click(within(r).getByText("Delete folder…"));
    expect(r.textContent).toContain("cannot be brought back");
    fireEvent.click(within(r).getByText("Delete for good"));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("worktree_storage_remove", { path: GONE.path, allowUnrecoverable: true }));
  });

  it("merged-and-clean and orphaned-and-clean worktrees remove in one click", async () => {
    routeInvoke(report([LANDED, ORPHAN]), { worktree_storage_remove: { path: LANDED.path, removed: true, error: null, freedBytes: 8 * GB, backup: null } });
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("landed-work");
    expect(row(LANDED.path).textContent).toContain("Nothing to lose · the branch stays");
    expect(row(ORPHAN.path).textContent).toContain("No session");
    fireEvent.click(within(row(LANDED.path)).getByTestId("storage-remove"));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("worktree_storage_remove", { path: LANDED.path, allowUnrecoverable: false }));
    expect((await screen.findByTestId("storage-note")).textContent).toBe("Removed landed-work and freed 8.0 GB.");
  });

  it("removes build output on request and says changes stay", async () => {
    routeInvoke(report([DIRTY]), { worktree_storage_remove_build_output: { path: DIRTY.path, removed: ["node_modules"], freed_bytes: 3 * GB, failed: [] } });
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("dirty-work");
    fireEvent.click(within(row(DIRTY.path)).getByTestId("storage-remove-build-output"));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("worktree_storage_remove_build_output", { path: DIRTY.path }));
    expect((await screen.findByTestId("storage-note")).textContent).toContain("Changes and commits untouched");
  });

  it("'Clean up now' runs the automatic rules and reports what it freed", async () => {
    const after = report([OPEN, DIRTY]);
    routeInvoke(report([OPEN, DIRTY, LANDED, ORPHAN]), {
      worktree_storage_clean_up: {
        freedBytes: 13 * GB, removedWorktrees: [LANDED.path, ORPHAN.path], clearedBuildOutput: [DIRTY.path], backups: [], skipped: [], report: after,
      },
    });
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("landed-work");
    fireEvent.click(screen.getByTestId("storage-clean-up"));
    expect((await screen.findByTestId("storage-note")).textContent).toBe(
      "Freed 13.0 GB. Worktrees removed: 2. Build output cleared: 1. Nothing with changes was touched.",
    );
    expect(screen.queryByText("landed-work")).toBeNull();
  });

  it("'Clean up now' is disabled when nothing can go automatically", async () => {
    routeInvoke(report([OPEN]));
    render(<StorageSettings settings={{}} onChange={() => {}} />);
    await screen.findByText("open-work");
    expect((screen.getByTestId("storage-clean-up") as HTMLButtonElement).disabled).toBe(true);
  });

  it("settings save through the Settings panel", async () => {
    routeInvoke(report([]));
    const onChange = vi.fn();
    render(<StorageSettings settings={{ worktree_idle_days: "7" }} onChange={onChange} />);
    await screen.findByText(/No worktrees on disk/);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith("worktree_auto_cleanup", "false");
    fireEvent.change(screen.getByLabelText("A worktree is idle after"), { target: { value: "14" } });
    expect(onChange).toHaveBeenCalledWith("worktree_idle_days", "14");
    fireEvent.change(screen.getByLabelText("Warn when free disk space is under"), { target: { value: "50" } });
    expect(onChange).toHaveBeenCalledWith("worktree_low_disk_gb", "50");
  });
});

describe("storage notices", () => {
  const base = { freeBytes: 4 * GB, worktreeBytes: 88 * GB, autoBytes: 61 * GB, needsBytes: 25 * GB, freedBytes: 0, removedWorktrees: 0, clearedBuildOutput: 0 };

  it("low disk: persistent warning with the numbers and Review storage", () => {
    const onReview = vi.fn();
    const toast = storageNoticeToast({ ...base, kind: "low_disk" }, onReview);
    expect(toast.message).toBe("Low disk space: 4.0 GB free. Old worktrees use 88.0 GB; 61.0 GB can be freed without losing work.");
    expect(toast.type).toBe("warning");
    expect(toast.duration).toBeNull();
    toast.actions?.[0].onClick();
    expect(onReview).toHaveBeenCalled();
    expect(storageNoticeToast({ ...base, kind: "low_disk", worktreeBytes: 0 }, onReview).message).toBe("Low disk space: 4.0 GB free.");
  });

  it("cleaned and reclaimable", () => {
    expect(storageNoticeToast({ ...base, kind: "cleaned", freedBytes: 6.2 * GB }, () => {}).message)
      .toBe("Hermes freed 6.2 GB from old worktrees. Nothing with changes was touched.");
    expect(storageNoticeToast({ ...base, kind: "reclaimable" }, () => {}).message)
      .toBe("Old worktrees with work in them use 25.0 GB. Review them to free space.");
  });
});

describe("helpers", () => {
  it("groups by repo, biggest first", () => {
    const groups = groupByRepo([ORPHAN, GONE, LANDED, DIRTY]);
    expect(groups.map((g) => g.name)).toEqual(["app", "gone"]);
    expect(groups[0].worktrees[0].path).toBe(LANDED.path);
    expect(groups[0].autoBytes).toBe(13 * GB);
    expect(groups[0].needsYou).toBe(true);
  });

  it("formats sizes and days", () => {
    expect(formatStorageBytes(999)).toBe("999 B");
    expect(formatStorageBytes(4_200_000_000)).toBe("4.2 GB");
    expect(formatStorageBytes(460_000_000_000)).toBe("460 GB");
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(daysSince("2026-09-26T11:00:00Z", now)).toBe(7);
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince("junk", now)).toBeNull();
  });
});
