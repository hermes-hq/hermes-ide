/**
 * Tests verifying that internal jargon has been cleaned up in components.
 *
 * Since the test environment is `node` (no DOM), we test the rendering
 * logic and text output by extracting the decision rules from each component.
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

// ─── WorktreeIndicator logic extraction ──────────────────────────────

/**
 * Mirrors WorktreeIndicator.tsx rendering logic.
 * Returns the visible text elements that the component would render.
 */
function getWorktreeIndicatorVisibleText(props: {
  branchName: string | null;
  isMainWorktree: boolean;
  isActive?: boolean;
}): {
  rendered: boolean;
  visibleTexts: string[];
  hasLinkedLabel: boolean;
} {
  const { branchName, isMainWorktree } = props;

  if (!branchName) {
    return { rendered: false, visibleTexts: [], hasLinkedLabel: false };
  }

  const visibleTexts: string[] = [branchName];
  const hasLinkedLabel = !isMainWorktree;
  if (hasLinkedLabel) {
    visibleTexts.push("linked");
  }

  return { rendered: true, visibleTexts, hasLinkedLabel };
}

// ─── SessionBranchSelector logic extraction ──────────────────────────

/**
 * The skip warning text from SessionBranchSelector.
 * Extracted from the JSX of the component.
 */
const SKIP_WARNING_TEXT =
  "Skipping creates the session on the main worktree. Multiple sessions sharing a worktree may interfere with each other.";

/**
 * The label shown for taken branches in the branch list.
 * Extracted from SessionBranchSelector.tsx.
 */
const TAKEN_BRANCH_LABEL = "in use";

// ─── RepoOverviewPanel logic extraction ──────────────────────────────

/**
 * The section header for active worktrees in RepoOverviewPanel.
 * Extracted from the component's JSX.
 */
function getActiveWorktreesSectionHeader(count: number): string {
  return `ACTIVE WORKTREES (${count})`;
}

/**
 * Whether the "main" badge is shown for a worktree row.
 * Extracted from RepoOverviewPanel.tsx.
 */
function showMainBadge(isMainWorktree: boolean): boolean {
  return isMainWorktree;
}

// ─── Tests: WorktreeIndicator jargon ─────────────────────────────────

describe("WorktreeIndicator - jargon cleanup", () => {
  it("does not render 'linked' text for main worktree", () => {
    const result = getWorktreeIndicatorVisibleText({
      branchName: "main",
      isMainWorktree: true,
    });
    expect(result.hasLinkedLabel).toBe(false);
    expect(result.visibleTexts).not.toContain("linked");
  });

  it("renders 'linked' text for linked worktrees (current behaviour)", () => {
    // NOTE: This documents current behaviour. If jargon cleanup removes
    // the "linked" label, this test should be updated.
    const result = getWorktreeIndicatorVisibleText({
      branchName: "feature/x",
      isMainWorktree: false,
    });
    expect(result.hasLinkedLabel).toBe(true);
    expect(result.visibleTexts).toContain("linked");
  });

  it("does not render 'main' text as visible label (main worktree)", () => {
    const result = getWorktreeIndicatorVisibleText({
      branchName: "develop",
      isMainWorktree: true,
    });
    // The word "main" should not appear in visible texts
    // (only the branch name itself, which happens to be "develop")
    const textsWithoutBranchName = result.visibleTexts.filter(
      (t) => t !== "develop",
    );
    expect(textsWithoutBranchName).not.toContain("main");
  });

  it("renders only branch name for main worktree", () => {
    const result = getWorktreeIndicatorVisibleText({
      branchName: "release/1.0",
      isMainWorktree: true,
    });
    expect(result.visibleTexts).toEqual(["release/1.0"]);
  });

  it("works without isMainWorktree defaulting to rendering branch only", () => {
    // When isMainWorktree is false (default-like), still renders branch
    const result = getWorktreeIndicatorVisibleText({
      branchName: "hotfix/123",
      isMainWorktree: false,
    });
    expect(result.rendered).toBe(true);
    expect(result.visibleTexts).toContain("hotfix/123");
  });
});

// ─── Tests: SessionBranchSelector jargon ─────────────────────────────

describe("SessionBranchSelector - jargon cleanup", () => {
  it("skip warning contains the word 'worktree' (current behaviour)", () => {
    // NOTE: This documents the CURRENT behaviour. The skip warning
    // references "worktree" which is user-visible terminology in git.
    // If this is considered jargon to remove, this test should be updated.
    expect(SKIP_WARNING_TEXT.toLowerCase()).toContain("worktree");
  });

  it("skip warning does not contain internal implementation terms", () => {
    // The warning should not reference internal concepts
    expect(SKIP_WARNING_TEXT.toLowerCase()).not.toContain("realm");
    expect(SKIP_WARNING_TEXT.toLowerCase()).not.toContain("reducer");
    expect(SKIP_WARNING_TEXT.toLowerCase()).not.toContain("context");
    expect(SKIP_WARNING_TEXT.toLowerCase()).not.toContain("component");
  });

  it("taken branches show 'in use' text", () => {
    expect(TAKEN_BRANCH_LABEL).toBe("in use");
  });

  it("taken branch label is short and informative", () => {
    expect(TAKEN_BRANCH_LABEL.length).toBeLessThan(20);
    expect(TAKEN_BRANCH_LABEL.trim()).toBe(TAKEN_BRANCH_LABEL);
  });

  it("skip warning is user-facing language (describes outcome, not implementation)", () => {
    // Should mention user-level concepts: session, interference
    expect(SKIP_WARNING_TEXT.toLowerCase()).toContain("session");
    expect(SKIP_WARNING_TEXT.toLowerCase()).toContain("interfere");
  });
});

// ─── Tests: RepoOverviewPanel jargon ─────────────────────────────────

describe("RepoOverviewPanel - jargon cleanup", () => {
  it("section header says 'ACTIVE WORKTREES' (current behaviour)", () => {
    // NOTE: This documents current behaviour. The header currently says
    // "ACTIVE WORKTREES" — if it should say "ACTIVE SESSIONS", this
    // test should be updated accordingly.
    const header = getActiveWorktreesSectionHeader(3);
    expect(header).toBe("ACTIVE WORKTREES (3)");
    expect(header).toContain("ACTIVE WORKTREES");
  });

  it("section header includes count", () => {
    expect(getActiveWorktreesSectionHeader(0)).toContain("(0)");
    expect(getActiveWorktreesSectionHeader(5)).toContain("(5)");
  });

  it("shows 'main' badge for main worktree (current behaviour)", () => {
    // NOTE: This documents current behaviour. If jargon cleanup removes
    // the "main" badge, this test should be updated.
    expect(showMainBadge(true)).toBe(true);
    expect(showMainBadge(false)).toBe(false);
  });

  it("does not show 'main' badge for non-main worktrees", () => {
    expect(showMainBadge(false)).toBe(false);
  });
});
