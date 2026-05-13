// @vitest-environment jsdom
/**
 * Single-click commits on the Existing Branch tab.
 *
 * Context — what changed and why:
 * The previous flow required two clicks: click a row to "select" (highlight)
 * and click "Use Branch" to commit.  In multi-project sessions this trap was
 * silent: users picked a branch in each expanded picker but never committed,
 * the outer auto-progression never fired, and they ended up with zero
 * isolated branches.
 *
 * New contract:
 *   1. Clicking a row on the Existing Branch tab fires `onBranchSelected`
 *      immediately — no intermediate selection state.
 *   2. The inner "Use Branch" button is gone from the Existing tab.
 *   3. The inner "Use current branch" button is gone from the Existing tab's
 *      normal (list-rendered) state.  The outer "Continue without isolation"
 *      button in SessionCreator now owns that role.
 *   4. The New Branch tab is unchanged — still uses its "Create & Use Branch"
 *      submit button (you cannot commit-on-click in a form).
 *   5. Keyboard Enter on the highlighted row commits in one step (no
 *      select-then-confirm).
 *   6. Remote-only branches show a "remote" badge so the single click feels
 *      intentional, not surprising.
 *   7. Taken (in-use) branches still cannot be clicked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement Element.scrollIntoView — the picker calls it when
// keyboard nav highlights an out-of-view row.  No-op shim so the effect runs.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

// ─── Mock the git API used by SessionBranchSelector ──────────────────
vi.mock("../api/git", () => ({
  gitListBranchesForProject: vi.fn(),
  listWorktrees: vi.fn(),
  checkBranchAvailable: vi.fn(),
  fetchRemoteBranches: vi.fn(),
}));

import {
  gitListBranchesForProject,
  listWorktrees,
  checkBranchAvailable,
} from "../api/git";
import { SessionBranchSelector } from "../components/SessionBranchSelector";
import type { GitBranch, WorktreeInfo } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeBranch(overrides: Partial<GitBranch> = {}): GitBranch {
  return {
    name: "main",
    is_current: false,
    is_remote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    last_commit_summary: null,
    ...overrides,
  };
}

function setupBranches(
  branches: GitBranch[],
  worktrees: WorktreeInfo[] = [],
): void {
  vi.mocked(gitListBranchesForProject).mockResolvedValue(branches);
  vi.mocked(listWorktrees).mockResolvedValue(worktrees);
  vi.mocked(checkBranchAvailable).mockResolvedValue({
    available: true,
    usedBySession: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

/**
 * The picker auto-propagates the current local branch on mount (a v1.2.x
 * fix for the "no isolation when user doesn't click" trap).  These tests
 * are about USER click/keyboard behaviour layered on top of that — so the
 * pattern is: render, wait for auto-propagation to settle, clear the mock,
 * then exercise the click and assert on what the click alone produced.
 */
async function renderAndSettle(onBranchSelected: ReturnType<typeof vi.fn>): Promise<void> {
  // Wait until either auto-propagation has fired (current branch was
  // safe to propagate) OR the picker has rendered without firing
  // (existingBranchName provided, or current branch is taken/missing).
  // Either way, the list rows are visible.
  await waitFor(() => {
    expect(screen.queryByText(/Loading branches/i)).toBeNull();
  });
  onBranchSelected.mockClear();
}

// ─── Click-to-commit behavior ────────────────────────────────────────

describe("SessionBranchSelector — single-click commits (Existing tab)", () => {
  it("fires onBranchSelected immediately on row click for a local branch", async () => {
    setupBranches([
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "feature/auth" }),
    ]);
    const onBranchSelected = vi.fn();

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={onBranchSelected}
        onSkip={() => {}}
      />,
    );

    // Wait for branches to load + auto-propagation to settle.
    const row = await screen.findByText("feature/auth");
    await renderAndSettle(onBranchSelected);

    fireEvent.click(row);

    expect(onBranchSelected).toHaveBeenCalledTimes(1);
    expect(onBranchSelected).toHaveBeenCalledWith("feature/auth", false);
  });

  it("fires onBranchSelected with stripped name + fromRemote for a remote-only branch", async () => {
    setupBranches([
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "origin/release-1.0", is_remote: true }),
    ]);
    const onBranchSelected = vi.fn();

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={onBranchSelected}
        onSkip={() => {}}
      />,
    );

    const row = await screen.findByText("release-1.0");
    await renderAndSettle(onBranchSelected);
    fireEvent.click(row);

    expect(onBranchSelected).toHaveBeenCalledTimes(1);
    expect(onBranchSelected).toHaveBeenCalledWith(
      "release-1.0",
      false,
      "origin/release-1.0",
    );
  });

  it("does NOT render a 'Use Branch' button on the Existing tab", async () => {
    setupBranches([makeBranch({ name: "main", is_current: true })]);

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={() => {}}
        onSkip={() => {}}
      />,
    );

    // Wait for the list to render
    await screen.findByText("main");

    // No "Use Branch" button — single-click is the commit.
    expect(screen.queryByRole("button", { name: /^Use Branch$/i })).toBeNull();
  });

  it("keeps the 'Use current branch' per-project escape button", async () => {
    // Multi-project sessions: each project can independently opt out of
    // isolation.  The outer modal's "Continue without isolation" skips
    // ALL projects — a different operation — so the per-project button
    // must stay.
    setupBranches([makeBranch({ name: "main", is_current: true })]);

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={() => {}}
        onSkip={() => {}}
      />,
    );

    await screen.findByText("main");

    expect(
      screen.getByRole("button", { name: /Use current branch/i }),
    ).toBeInTheDocument();
  });

  it("does NOT fire onBranchSelected when clicking a taken (in-use) branch", async () => {
    setupBranches(
      [
        makeBranch({ name: "main", is_current: true }),
        makeBranch({ name: "feature/locked" }),
      ],
      [
        {
          sessionId: "other-session",
          projectId: "proj-1",
          branchName: "feature/locked",
          worktreePath: "/tmp/wt",
          isMainWorktree: false,
        } as WorktreeInfo,
      ],
    );
    const onBranchSelected = vi.fn();

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={onBranchSelected}
        onSkip={() => {}}
      />,
    );

    const row = await screen.findByText("feature/locked");
    await renderAndSettle(onBranchSelected);
    fireEvent.click(row);

    // Clicks on taken rows are a no-op (the row keeps its "in use" label).
    expect(onBranchSelected).not.toHaveBeenCalled();
  });

  it("keyboard Enter on highlighted row commits in a single step", async () => {
    setupBranches([
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "feature/auth" }),
    ]);
    const onBranchSelected = vi.fn();

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={onBranchSelected}
        onSkip={() => {}}
      />,
    );

    // Wait for list to load + auto-propagation to settle.
    await screen.findByText("feature/auth");
    await renderAndSettle(onBranchSelected);

    // Search input has focus; ArrowDown to highlight first item, Enter to commit.
    const search = screen.getByPlaceholderText(/Filter branches/i);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    // Single Enter should commit (no need for select-then-confirm).
    await waitFor(() => {
      expect(onBranchSelected).toHaveBeenCalledTimes(1);
    });
    // First row in the sorted list is "main" (priority 0).
    expect(onBranchSelected).toHaveBeenCalledWith("main", false);
  });
});

// ─── New Branch tab unchanged ────────────────────────────────────────

describe("SessionBranchSelector — New Branch tab (unchanged)", () => {
  it("still renders the 'Create & Use Branch' submit button", async () => {
    setupBranches([makeBranch({ name: "main", is_current: true })]);

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={() => {}}
        onSkip={() => {}}
      />,
    );

    // Wait for tabs to render, then switch to the New Branch tab.
    const newTab = await screen.findByRole("button", { name: /New Branch/i });
    fireEvent.click(newTab);

    // The submit button must still exist — a click-on-form-field would be
    // wrong (you're typing).
    expect(
      screen.getByRole("button", { name: /Create & Use Branch/i }),
    ).toBeInTheDocument();
  });
});

// ─── Remote badge for discoverability ────────────────────────────────

describe("SessionBranchSelector — remote-only branch affordance", () => {
  it("marks remote-only rows with the remote class so users see it's a remote branch", async () => {
    setupBranches([
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "origin/feature-x", is_remote: true }),
    ]);

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={() => {}}
        onSkip={() => {}}
      />,
    );

    const remoteRow = await screen.findByText("feature-x");
    // Walk up to the row container and assert the remote modifier class.
    const row = remoteRow.closest(".branch-selector-item");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("branch-selector-item-remote");
  });

  it("does NOT mark local-only rows with the remote class", async () => {
    setupBranches([
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "feature-x" }),
    ]);

    render(
      <SessionBranchSelector
        projectId="proj-1"
        onBranchSelected={() => {}}
        onSkip={() => {}}
      />,
    );

    const localRow = await screen.findByText("feature-x");
    const row = localRow.closest(".branch-selector-item");
    expect(row).not.toBeNull();
    expect(row!.className).not.toContain("branch-selector-item-remote");
  });
});
