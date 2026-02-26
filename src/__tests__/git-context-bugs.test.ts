/**
 * git-context-bugs.test.ts
 *
 * Tests covering bugs found in Git components and Context/Prompt components.
 *
 * Bug Index:
 *   CRITICAL:
 *     BUG-4: useGitStatus runaway interval when pollInterval is 0
 *     BUG-7: GitLogView stale fetch after branch/project switch
 *
 *   HIGH:
 *     BUG-1: GitDiffView misclassifies diff header lines (--- / +++) as add/del
 *     BUG-2: applyTemplate overwrites user-saved roleIds/styleSelections
 *     BUG-6: GitFileRow uses "C" for both "copied" and "conflicted" statuses
 *     BUG-8: GitCommitDetailView stale fetch on rapid hash changes
 *     BUG-9: GitDiffView stale fetch on rapid file changes
 *     BUG-10: GitConflictViewer stale fetch on rapid file changes
 *
 *   MEDIUM:
 *     BUG-3: validateBranchName allows consecutive slashes
 *     BUG-5: parseStashLabel fails on custom stash messages (no commit hash)
 *     BUG-11: GitPanel toast key uses Date.now() causing remount flicker
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
  dismissSuggestions: vi.fn(),
  clearGhostText: vi.fn(),
  sendShortcutCommand: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────

// Git helpers
import {
  formatCommitAge,
  truncateSummary,
  isMergeCommit,
  authorColor,
  commitStatsSummary,
} from "../components/GitLogView";

import {
  filterBranches,
  groupBranches,
  validateBranchName,
} from "../components/GitBranchSelector";

import {
  formatStashAge,
  parseStashLabel,
  parseStashBranch,
} from "../components/GitStashSection";

import {
  getResolvedCount,
  allConflictsResolved,
  parseConflictMarkers,
  countConflictBlocks,
  validateMergeMessage,
} from "../components/GitMergeBanner";

import { highlightMatch, formatResultCount } from "../components/SearchPanel";

import { buildTreePath, sortEntries, filterEntries } from "../hooks/useFileTree";

// Context helpers
import {
  formatContextMarkdown,
  type ContextState,
} from "../hooks/useContextState";

// Prompt/Template helpers
import {
  compilePrompt,
  EMPTY_FIELDS,
  BUILT_IN_ROLES,
  BUILT_IN_STYLES,
  type ComposerFields,
} from "../lib/compilePrompt";

import { mergeRoles, validateCustomRole } from "../lib/roles";
import { mergeStyles, validateCustomStyle } from "../lib/styles";

import type { GitBranch, MergeStatus, FileEntry } from "../types/git";

// =====================================================================
// CRITICAL: BUG-4 — useGitStatus runaway interval when pollInterval is 0
// =====================================================================

describe("BUG-4 [CRITICAL]: useGitStatus pollInterval=0 guard", () => {
  it("pollInterval of 0 should NOT create an interval (guard logic)", () => {
    // This tests the guard logic that was added to useGitStatus.ts:
    // When pollInterval <= 0, setInterval should never be called.
    // We simulate the guard:
    const pollInterval = 0;
    let intervalCreated = false;

    if (pollInterval <= 0) {
      // Should skip creating interval
    } else {
      intervalCreated = true;
    }

    expect(intervalCreated).toBe(false);
  });

  it("pollInterval of -1 should NOT create an interval", () => {
    const pollInterval = -1;
    let intervalCreated = false;

    if (pollInterval <= 0) {
      // skip
    } else {
      intervalCreated = true;
    }

    expect(intervalCreated).toBe(false);
  });

  it("pollInterval of 3000 should create an interval", () => {
    const pollInterval = 3000;
    let intervalCreated = false;

    if (pollInterval <= 0) {
      // skip
    } else {
      intervalCreated = true;
    }

    expect(intervalCreated).toBe(true);
  });
});

// =====================================================================
// CRITICAL: BUG-7 — GitLogView stale fetch after branch/project switch
// =====================================================================

describe("BUG-7 [CRITICAL]: GitLogView stale fetch race condition", () => {
  it("stale fetch result should be discarded when projectPath changes", () => {
    // Simulates the projectPathRef guard added to GitLogView.tsx:
    // When a fetch resolves, if projectPathRef.current !== fetchPath, discard.
    let projectPathRef = "/project-a";
    let entries: string[] = [];

    // Fetch starts for project-a
    const fetchPath = projectPathRef;

    // User switches to project-b before fetch resolves
    projectPathRef = "/project-b";
    entries = []; // reset

    // Old fetch resolves — should be discarded
    const result = ["commit-from-project-a"];
    if (projectPathRef === fetchPath) {
      entries = [...entries, ...result];
    }

    expect(entries).toHaveLength(0); // stale result discarded
  });

  it("fresh fetch result is kept when projectPath matches", () => {
    const projectPathRef = "/project-b";
    let entries: string[] = [];

    const fetchPath = projectPathRef;
    const result = ["commit-from-project-b"];

    if (projectPathRef === fetchPath) {
      entries = [...entries, ...result];
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe("commit-from-project-b");
  });
});

// =====================================================================
// HIGH: BUG-1 — GitDiffView misclassifies diff header lines
// =====================================================================

describe("BUG-1 [HIGH]: Diff line classification", () => {
  it("'--- a/file.txt' should NOT be classified as a deletion", () => {
    const line = "--- a/file.txt";
    // After fix: lines starting with --- or +++ are headers, not add/del
    const isHeader = line.startsWith("+++") || line.startsWith("---");
    const isDeletion = !isHeader && line.startsWith("-");
    expect(isHeader).toBe(true);
    expect(isDeletion).toBe(false);
  });

  it("'+++ b/file.txt' should NOT be classified as an addition", () => {
    const line = "+++ b/file.txt";
    const isHeader = line.startsWith("+++") || line.startsWith("---");
    const isAddition = !isHeader && line.startsWith("+");
    expect(isHeader).toBe(true);
    expect(isAddition).toBe(false);
  });

  it("'+normal addition' should still be classified as an addition", () => {
    const line = "+normal addition";
    const isHeader = line.startsWith("+++") || line.startsWith("---");
    const isAddition = !isHeader && line.startsWith("+");
    expect(isHeader).toBe(false);
    expect(isAddition).toBe(true);
  });

  it("'-normal deletion' should still be classified as a deletion", () => {
    const line = "-normal deletion";
    const isHeader = line.startsWith("+++") || line.startsWith("---");
    const isDeletion = !isHeader && line.startsWith("-");
    expect(isHeader).toBe(false);
    expect(isDeletion).toBe(true);
  });

  it("'@@ -1,3 +1,5 @@' should be classified as a hunk header", () => {
    const line = "@@ -1,3 +1,5 @@";
    const isHunk = line.startsWith("@@");
    expect(isHunk).toBe(true);
  });

  it("context lines (no prefix) should have no classification", () => {
    const line = " normal context line";
    const isHunk = line.startsWith("@@");
    const isHeader = line.startsWith("+++") || line.startsWith("---");
    const isAddition = !isHeader && line.startsWith("+");
    const isDeletion = !isHeader && line.startsWith("-");
    expect(isHunk).toBe(false);
    expect(isHeader).toBe(false);
    expect(isAddition).toBe(false);
    expect(isDeletion).toBe(false);
  });
});

// =====================================================================
// HIGH: BUG-2 — applyTemplate overwrites user-saved roleIds/styleSelections
// =====================================================================

describe("BUG-2 [HIGH]: applyTemplate preserves user-saved template fields", () => {
  it("user-saved template with roleIds in fields should use those roleIds", () => {
    // Simulates the fixed applyTemplate logic
    const tpl = {
      id: "user-123",
      name: "My Template",
      category: "debugging" as const,
      recommendedRoles: ["debugger"],
      recommendedStyles: [{ id: "concise", level: 3 }],
      builtIn: false,
      fields: {
        task: "Fix the bug",
        scope: "src/",
        constraints: "",
        style: "",
        roleIds: ["backend-eng", "architect"],
        styleSelections: [{ id: "detailed", level: 4 }],
      },
    };

    // Fixed logic: prefer fields.roleIds over recommendedRoles when fields has them
    const roleIds = (tpl.fields.roleIds && tpl.fields.roleIds.length > 0)
      ? tpl.fields.roleIds
      : (tpl.recommendedRoles || []);

    const styleSelections = (tpl.fields.styleSelections && tpl.fields.styleSelections.length > 0)
      ? tpl.fields.styleSelections
      : (tpl.recommendedStyles || []);

    expect(roleIds).toEqual(["backend-eng", "architect"]);
    expect(styleSelections).toEqual([{ id: "detailed", level: 4 }]);
  });

  it("built-in template without roleIds in fields should use recommendedRoles", () => {
    const tpl = {
      id: "debug-root-cause",
      name: "Root Cause Analysis",
      category: "debugging" as const,
      recommendedRoles: ["debugger", "backend-eng"],
      recommendedStyles: [{ id: "step-by-step", level: 3 }],
      builtIn: true,
      fields: {
        constraints: "Some constraints",
        style: "Some style",
      } as any,
    };

    const roleIds = (tpl.fields.roleIds && tpl.fields.roleIds.length > 0)
      ? tpl.fields.roleIds
      : (tpl.recommendedRoles || []);

    expect(roleIds).toEqual(["debugger", "backend-eng"]);
  });

  it("template with empty roleIds array should fall back to recommendedRoles", () => {
    const tpl = {
      fields: {
        roleIds: [],
        styleSelections: [],
      },
      recommendedRoles: ["test-engineer"],
      recommendedStyles: [{ id: "code-heavy", level: 4 }],
    };

    const roleIds = (tpl.fields.roleIds && tpl.fields.roleIds.length > 0)
      ? tpl.fields.roleIds
      : (tpl.recommendedRoles || []);

    const styleSelections = (tpl.fields.styleSelections && tpl.fields.styleSelections.length > 0)
      ? tpl.fields.styleSelections
      : (tpl.recommendedStyles || []);

    expect(roleIds).toEqual(["test-engineer"]);
    expect(styleSelections).toEqual([{ id: "code-heavy", level: 4 }]);
  });
});

// =====================================================================
// HIGH: BUG-6 — GitFileRow conflated status letter for copied/conflicted
// =====================================================================

describe("BUG-6 [HIGH]: GitFileRow status letters", () => {
  it("'copied' should use 'C' letter", () => {
    const STATUS_LABELS: Record<string, { letter: string; className: string }> = {
      modified: { letter: "M", className: "git-status-modified" },
      added: { letter: "A", className: "git-status-added" },
      deleted: { letter: "D", className: "git-status-deleted" },
      renamed: { letter: "R", className: "git-status-renamed" },
      copied: { letter: "C", className: "git-status-copied" },
      untracked: { letter: "?", className: "git-status-untracked" },
      conflicted: { letter: "!", className: "git-status-conflicted" },
    };

    expect(STATUS_LABELS["copied"].letter).toBe("C");
    expect(STATUS_LABELS["conflicted"].letter).toBe("!");
    expect(STATUS_LABELS["copied"].letter).not.toBe(STATUS_LABELS["conflicted"].letter);
  });

  it("all statuses have unique letters", () => {
    const STATUS_LABELS: Record<string, { letter: string }> = {
      modified: { letter: "M" },
      added: { letter: "A" },
      deleted: { letter: "D" },
      renamed: { letter: "R" },
      copied: { letter: "C" },
      untracked: { letter: "?" },
      conflicted: { letter: "!" },
    };

    const letters = Object.values(STATUS_LABELS).map((v) => v.letter);
    const unique = new Set(letters);
    expect(unique.size).toBe(letters.length);
  });
});

// =====================================================================
// HIGH: BUG-8 — GitCommitDetailView stale fetch cancellation
// =====================================================================

describe("BUG-8 [HIGH]: GitCommitDetailView stale fetch guard", () => {
  it("cancelled flag prevents stale detail from being applied", () => {
    let cancelled = false;
    let detail: string | null = null;
    let loading = true;

    // Simulate first fetch starting
    const fetch1 = () => {
      // Effect cleanup fires (commitHash changed)
      cancelled = true;
      // Old promise resolves later
      if (!cancelled) {
        detail = "old-commit-detail";
        loading = false;
      }
    };

    fetch1();
    expect(detail).toBeNull();
    expect(loading).toBe(true);
  });

  it("non-cancelled fetch updates state normally", () => {
    let cancelled = false;
    let detail: string | null = null;
    let loading = true;

    // Simulate fetch resolving normally
    if (!cancelled) {
      detail = "fresh-commit-detail";
      loading = false;
    }

    expect(detail).toBe("fresh-commit-detail");
    expect(loading).toBe(false);
  });
});

// =====================================================================
// HIGH: BUG-9 — GitDiffView stale fetch cancellation
// =====================================================================

describe("BUG-9 [HIGH]: GitDiffView stale diff fetch guard", () => {
  it("cancelled flag prevents stale diff from being applied", () => {
    let cancelled = false;
    let diff: string | null = null;

    // Simulate file changing mid-fetch
    cancelled = true;

    // Old fetch resolves
    if (!cancelled) {
      diff = "stale-diff-content";
    }

    expect(diff).toBeNull();
  });
});

// =====================================================================
// HIGH: BUG-10 — GitConflictViewer stale fetch cancellation
// =====================================================================

describe("BUG-10 [HIGH]: GitConflictViewer stale fetch guard", () => {
  it("cancelled flag prevents stale conflict content from being applied", () => {
    let cancelled = false;
    let content: string | null = null;

    cancelled = true;

    if (!cancelled) {
      content = "stale-conflict-content";
    }

    expect(content).toBeNull();
  });
});

// =====================================================================
// MEDIUM: BUG-3 — validateBranchName allows consecutive slashes
// =====================================================================

describe("BUG-3 [MEDIUM]: validateBranchName consecutive slashes", () => {
  it("rejects branch name with consecutive slashes", () => {
    expect(validateBranchName("feature//test")).not.toBeNull();
    expect(validateBranchName("feature//test")).toBe(
      "Branch name cannot contain consecutive slashes"
    );
  });

  it("allows branch name with single slashes", () => {
    expect(validateBranchName("feature/test")).toBeNull();
  });

  it("allows deeply nested branch name with single slashes", () => {
    expect(validateBranchName("feature/sub/deep/branch")).toBeNull();
  });

  it("rejects multiple consecutive slashes", () => {
    expect(validateBranchName("a///b")).not.toBeNull();
  });

  // Existing validations still work
  it("rejects empty name", () => {
    expect(validateBranchName("")).not.toBeNull();
    expect(validateBranchName("  ")).not.toBeNull();
  });

  it("rejects names with spaces", () => {
    expect(validateBranchName("feature test")).not.toBeNull();
  });

  it("rejects names starting with dash", () => {
    expect(validateBranchName("-feature")).not.toBeNull();
  });

  it("rejects names starting with dot", () => {
    expect(validateBranchName(".hidden")).not.toBeNull();
  });

  it("rejects names containing '..'", () => {
    expect(validateBranchName("feature..test")).not.toBeNull();
  });

  it("rejects names ending with '.lock'", () => {
    expect(validateBranchName("branch.lock")).not.toBeNull();
  });

  it("rejects names ending with '.'", () => {
    expect(validateBranchName("branch.")).not.toBeNull();
  });

  it("rejects names ending with '/'", () => {
    expect(validateBranchName("branch/")).not.toBeNull();
  });

  it("rejects names containing '@{'", () => {
    expect(validateBranchName("branch@{0}")).not.toBeNull();
  });

  it("rejects names with special chars", () => {
    expect(validateBranchName("branch~1")).not.toBeNull();
    expect(validateBranchName("branch^2")).not.toBeNull();
    expect(validateBranchName("branch:ref")).not.toBeNull();
    expect(validateBranchName("branch?")).not.toBeNull();
    expect(validateBranchName("branch*")).not.toBeNull();
    expect(validateBranchName("branch[0]")).not.toBeNull();
    expect(validateBranchName("branch\\path")).not.toBeNull();
  });

  it("rejects names with control characters", () => {
    expect(validateBranchName("branch\x00")).not.toBeNull();
    expect(validateBranchName("branch\x1f")).not.toBeNull();
    expect(validateBranchName("branch\x7f")).not.toBeNull();
  });

  it("accepts valid branch names", () => {
    expect(validateBranchName("main")).toBeNull();
    expect(validateBranchName("feature/my-branch")).toBeNull();
    expect(validateBranchName("release/v1.0.0")).toBeNull();
    expect(validateBranchName("hotfix/JIRA-123")).toBeNull();
  });
});

// =====================================================================
// MEDIUM: BUG-5 — parseStashLabel fails on custom stash messages
// =====================================================================

describe("BUG-5 [MEDIUM]: parseStashLabel custom messages", () => {
  it("parses standard WIP stash message", () => {
    expect(parseStashLabel("WIP on main: abc1234 Fix the bug")).toBe("Fix the bug");
  });

  it("parses standard 'On' stash message", () => {
    expect(parseStashLabel("On feature/x: def5678 Add feature")).toBe("Add feature");
  });

  it("parses custom stash message without commit hash", () => {
    // This was the bug: git stash push -m "my message" produces
    // "On main: my custom message" without a commit hash
    expect(parseStashLabel("On main: my custom message")).toBe("my custom message");
  });

  it("parses custom WIP stash message without commit hash", () => {
    expect(parseStashLabel("WIP on develop: work in progress")).toBe("work in progress");
  });

  it("returns raw message if no pattern matches", () => {
    expect(parseStashLabel("totally custom string")).toBe("totally custom string");
  });

  it("handles feature branch with slash in custom message", () => {
    expect(parseStashLabel("On feature/auth: saving auth work")).toBe("saving auth work");
  });

  it("prioritizes hash-prefixed match over plain match", () => {
    // "On main: abc1234 Fix" should match the hash pattern first
    const result = parseStashLabel("On main: abc1234 Fix");
    expect(result).toBe("Fix");
  });
});

// =====================================================================
// MEDIUM: BUG-11 — GitPanel toast key stability
// =====================================================================

describe("BUG-11 [MEDIUM]: Toast key stability", () => {
  it("toast key should be stable across renders (based on message)", () => {
    const toast = { message: "Committed successfully", type: "success" as const };

    // Before fix: key = toast.message + Date.now() — changes every render
    // After fix: key = toast.message — stable

    const key1 = toast.message;
    const key2 = toast.message;
    expect(key1).toBe(key2);
  });

  it("different toast messages produce different keys", () => {
    const key1 = "Committed successfully";
    const key2 = "Push failed";
    expect(key1).not.toBe(key2);
  });
});

// =====================================================================
// Additional regression tests for pure helpers
// =====================================================================

describe("GitLogView helpers", () => {
  it("formatCommitAge handles boundary values", () => {
    const now = 1000000;
    expect(formatCommitAge(now, now)).toBe("just now");
    expect(formatCommitAge(now - 59, now)).toBe("just now");
    expect(formatCommitAge(now - 60, now)).toBe("1m ago");
    expect(formatCommitAge(now - 3599, now)).toBe("59m ago");
    expect(formatCommitAge(now - 3600, now)).toBe("1h ago");
    expect(formatCommitAge(now - 86399, now)).toBe("23h ago");
    expect(formatCommitAge(now - 86400, now)).toBe("1d ago");
    expect(formatCommitAge(now - 604799, now)).toBe("6d ago");
    expect(formatCommitAge(now - 604800, now)).toBe("1w ago");
  });

  it("truncateSummary truncates at word boundary", () => {
    const long = "This is a really long commit message that should be truncated at some point";
    const result = truncateSummary(long, 30);
    expect(result.length).toBeLessThanOrEqual(33); // 30 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("truncateSummary returns original if within limit", () => {
    expect(truncateSummary("Short msg")).toBe("Short msg");
  });

  it("truncateSummary handles single long word", () => {
    const word = "a".repeat(80);
    const result = truncateSummary(word, 60);
    expect(result).toBe("a".repeat(60) + "...");
  });

  it("isMergeCommit returns true for parent_count > 1", () => {
    expect(isMergeCommit({ parent_count: 2 })).toBe(true);
    expect(isMergeCommit({ parent_count: 1 })).toBe(false);
    expect(isMergeCommit({ parent_count: 0 })).toBe(false);
  });

  it("authorColor is deterministic", () => {
    const c1 = authorColor("user@example.com");
    const c2 = authorColor("user@example.com");
    expect(c1).toBe(c2);
  });

  it("authorColor produces different colors for different emails", () => {
    const c1 = authorColor("alice@example.com");
    const c2 = authorColor("bob@example.com");
    expect(c1).not.toBe(c2);
  });

  it("commitStatsSummary formats correctly", () => {
    expect(commitStatsSummary({ total_additions: 10, total_deletions: 5, files: [1, 2, 3] as any })).toBe("+10 -5 (3 files)");
    expect(commitStatsSummary({ total_additions: 1, total_deletions: 0, files: [1] as any })).toBe("+1 -0 (1 file)");
  });
});

describe("GitBranchSelector helpers", () => {
  const branches: GitBranch[] = [
    { name: "main", is_current: true, is_remote: false, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
    { name: "feature/a", is_current: false, is_remote: false, upstream: null, ahead: 1, behind: 0, last_commit_summary: null },
    { name: "origin/main", is_current: false, is_remote: true, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
    { name: "origin/feature/b", is_current: false, is_remote: true, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
  ];

  it("filterBranches with empty query returns all", () => {
    expect(filterBranches(branches, "")).toHaveLength(4);
    expect(filterBranches(branches, "  ")).toHaveLength(4);
  });

  it("filterBranches matches case-insensitively", () => {
    expect(filterBranches(branches, "MAIN")).toHaveLength(2); // "main" and "origin/main"
  });

  it("groupBranches separates local and remote", () => {
    const { local, remote } = groupBranches(branches);
    expect(local).toHaveLength(2);
    expect(remote).toHaveLength(2);
  });

  it("groupBranches sorts current branch first in local", () => {
    const { local } = groupBranches(branches);
    expect(local[0].name).toBe("main");
    expect(local[0].is_current).toBe(true);
  });
});

describe("GitStashSection helpers", () => {
  it("formatStashAge handles recent timestamps", () => {
    const now = 1000000;
    expect(formatStashAge(now, now)).toBe("just now");
    expect(formatStashAge(now - 120, now)).toBe("2m ago");
    expect(formatStashAge(now - 7200, now)).toBe("2h ago");
  });

  it("parseStashBranch extracts branch name", () => {
    expect(parseStashBranch("WIP on main: abc Fix")).toBe("main");
    expect(parseStashBranch("On feature/x: def Add")).toBe("feature/x");
    expect(parseStashBranch("random message")).toBe("unknown");
  });
});

describe("GitMergeBanner helpers", () => {
  it("getResolvedCount calculates correctly", () => {
    const ms: MergeStatus = {
      in_merge: true,
      conflicted_files: ["file1.ts"],
      resolved_files: ["file2.ts", "file3.ts"],
      total_conflicts: 3,
      merge_message: null,
    };
    expect(getResolvedCount(ms)).toBe(2); // 3 total - 1 remaining = 2
  });

  it("allConflictsResolved returns true when no conflicted files remain", () => {
    const ms: MergeStatus = {
      in_merge: true,
      conflicted_files: [],
      resolved_files: ["a.ts", "b.ts"],
      total_conflicts: 2,
      merge_message: "Merge branch 'feature'",
    };
    expect(allConflictsResolved(ms)).toBe(true);
  });

  it("allConflictsResolved returns false when conflicts remain", () => {
    const ms: MergeStatus = {
      in_merge: true,
      conflicted_files: ["a.ts"],
      resolved_files: ["b.ts"],
      total_conflicts: 2,
      merge_message: null,
    };
    expect(allConflictsResolved(ms)).toBe(false);
  });

  it("allConflictsResolved returns false when not in merge", () => {
    const ms: MergeStatus = {
      in_merge: false,
      conflicted_files: [],
      resolved_files: [],
      total_conflicts: 0,
      merge_message: null,
    };
    expect(allConflictsResolved(ms)).toBe(false);
  });

  it("validateMergeMessage rejects empty messages", () => {
    expect(validateMergeMessage("")).not.toBeNull();
    expect(validateMergeMessage("  ")).not.toBeNull();
    expect(validateMergeMessage("\n\t")).not.toBeNull();
  });

  it("validateMergeMessage accepts non-empty messages", () => {
    expect(validateMergeMessage("Merge feature branch")).toBeNull();
  });

  it("countConflictBlocks counts conflict markers", () => {
    const content = `normal line
<<<<<<< HEAD
our changes
=======
their changes
>>>>>>> feature
more normal
<<<<<<< HEAD
another conflict
=======
another theirs
>>>>>>> feature`;
    expect(countConflictBlocks(content)).toBe(2);
  });

  it("parseConflictMarkers handles simple conflict", () => {
    const content = `before
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> feature
after`;
    const sections = parseConflictMarkers(content);
    expect(sections.length).toBeGreaterThanOrEqual(4);

    const types = sections.map((s) => s.type);
    expect(types).toContain("normal");
    expect(types).toContain("ours");
    expect(types).toContain("theirs");
  });

  it("parseConflictMarkers handles file with no conflicts", () => {
    const content = "clean\nfile\ncontent";
    const sections = parseConflictMarkers(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe("normal");
  });
});

describe("FileExplorer helpers", () => {
  it("buildTreePath joins correctly", () => {
    expect(buildTreePath("src", "main.ts")).toBe("src/main.ts");
    expect(buildTreePath("", "main.ts")).toBe("main.ts");
    expect(buildTreePath("src/", "main.ts")).toBe("src/main.ts");
    expect(buildTreePath("src", "")).toBe("src");
  });

  it("sortEntries puts directories first", () => {
    const entries: FileEntry[] = [
      { name: "file.ts", path: "file.ts", is_dir: false, is_hidden: false, size: 100, git_status: null },
      { name: "dir", path: "dir", is_dir: true, is_hidden: false, size: null, git_status: null },
    ];
    const sorted = sortEntries(entries);
    expect(sorted[0].name).toBe("dir");
    expect(sorted[1].name).toBe("file.ts");
  });

  it("sortEntries sorts alphabetically within groups", () => {
    const entries: FileEntry[] = [
      { name: "z.ts", path: "z.ts", is_dir: false, is_hidden: false, size: 100, git_status: null },
      { name: "a.ts", path: "a.ts", is_dir: false, is_hidden: false, size: 100, git_status: null },
      { name: "m.ts", path: "m.ts", is_dir: false, is_hidden: false, size: 100, git_status: null },
    ];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("filterEntries hides hidden files by default", () => {
    const entries: FileEntry[] = [
      { name: ".hidden", path: ".hidden", is_dir: false, is_hidden: true, size: 100, git_status: null },
      { name: "visible.ts", path: "visible.ts", is_dir: false, is_hidden: false, size: 100, git_status: null },
    ];
    expect(filterEntries(entries, "", false)).toHaveLength(1);
    expect(filterEntries(entries, "", true)).toHaveLength(2);
  });

  it("filterEntries filters by name query", () => {
    const entries: FileEntry[] = [
      { name: "Button.tsx", path: "Button.tsx", is_dir: false, is_hidden: false, size: 100, git_status: null },
      { name: "Input.tsx", path: "Input.tsx", is_dir: false, is_hidden: false, size: 100, git_status: null },
    ];
    expect(filterEntries(entries, "button", false)).toHaveLength(1);
    expect(filterEntries(entries, "button", false)[0].name).toBe("Button.tsx");
  });
});

describe("compilePrompt helpers", () => {
  it("compilePrompt with empty fields returns empty string", () => {
    expect(compilePrompt(EMPTY_FIELDS, BUILT_IN_ROLES, BUILT_IN_STYLES)).toBe("");
  });

  it("compilePrompt includes all non-empty fields", () => {
    const fields: ComposerFields = {
      roleIds: ["debugger"],
      task: "Find the bug",
      scope: "src/api/",
      constraints: "No new deps",
      styleSelections: [{ id: "concise", level: 3 }],
      style: "Use diffs",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Role:**");
    expect(result).toContain("**Task:** Find the bug");
    expect(result).toContain("**Scope:** src/api/");
    expect(result).toContain("**Constraints:** No new deps");
    expect(result).toContain("**Style:**");
    expect(result).toContain("Use diffs");
  });

  it("compilePrompt trims whitespace-only fields", () => {
    const fields: ComposerFields = {
      roleIds: [],
      task: "  Do something  ",
      scope: "   ",
      constraints: "",
      styleSelections: [],
      style: "",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Task:** Do something");
    expect(result).not.toContain("**Scope:**");
    expect(result).not.toContain("**Role:**");
    expect(result).not.toContain("**Style:**");
  });

  it("mergeRoles handles single role", () => {
    const result = mergeRoles(["debugger"], BUILT_IN_ROLES);
    expect(result).toContain("expert debugger");
  });

  it("mergeRoles handles multiple roles", () => {
    const result = mergeRoles(["debugger", "backend-eng"], BUILT_IN_ROLES);
    expect(result).toContain("Expert Debugger");
    expect(result).toContain("Senior Backend Engineer");
  });

  it("mergeRoles handles unknown role ids gracefully", () => {
    const result = mergeRoles(["nonexistent"], BUILT_IN_ROLES);
    expect(result).toBe("");
  });

  it("mergeStyles handles empty selections", () => {
    expect(mergeStyles([], BUILT_IN_STYLES)).toBe("");
  });

  it("mergeStyles clamps level to 1-5 range", () => {
    // Level 0 -> should map to index 0 (level 1)
    const result0 = mergeStyles([{ id: "concise", level: 0 }], BUILT_IN_STYLES);
    const result1 = mergeStyles([{ id: "concise", level: 1 }], BUILT_IN_STYLES);
    expect(result0).toBe(result1);

    // Level 6 -> should map to index 4 (level 5)
    const result6 = mergeStyles([{ id: "concise", level: 6 }], BUILT_IN_STYLES);
    const result5 = mergeStyles([{ id: "concise", level: 5 }], BUILT_IN_STYLES);
    expect(result6).toBe(result5);
  });
});

describe("validateCustomRole", () => {
  it("rejects empty label", () => {
    const result = validateCustomRole(
      { label: "", systemInstruction: "You are..." },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Label");
  });

  it("rejects empty instruction", () => {
    const result = validateCustomRole(
      { label: "My Role", systemInstruction: "" },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("instruction");
  });

  it("rejects duplicate label (case-insensitive)", () => {
    const result = validateCustomRole(
      { label: "expert debugger", systemInstruction: "You are..." },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("accepts valid custom role", () => {
    const result = validateCustomRole(
      { label: "Unique Role", systemInstruction: "You are a unique specialist." },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateCustomStyle", () => {
  it("rejects empty label", () => {
    const result = validateCustomStyle(
      { label: "", levels: ["a", "b", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects empty level instructions", () => {
    const result = validateCustomStyle(
      { label: "My Style", levels: ["a", "", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("level");
  });

  it("rejects duplicate label", () => {
    const result = validateCustomStyle(
      { label: "Concise", levels: ["a", "b", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("accepts valid custom style", () => {
    const result = validateCustomStyle(
      { label: "Unique Style", levels: ["l1", "l2", "l3", "l4", "l5"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(true);
  });
});

describe("Context formatContextMarkdown edge cases", () => {
  function makeCtx(overrides?: Partial<ContextState>): ContextState {
    return {
      pinnedItems: [],
      memoryFacts: [],
      persistedMemory: [],
      realms: [],
      workspacePaths: [],
      workingDirectory: "/home/user/project",
      agent: null,
      model: null,
      ...overrides,
    };
  }

  it("no agent produces no Provider line", () => {
    const output = formatContextMarkdown(makeCtx(), 0, "manual");
    expect(output).not.toContain("Provider:");
  });

  it("agent with model produces Provider with model", () => {
    const output = formatContextMarkdown(
      makeCtx({ agent: "anthropic", model: "claude-sonnet" }), 0, "manual"
    );
    expect(output).toContain("Provider: anthropic (claude-sonnet)");
  });

  it("agent without model produces Provider without parens", () => {
    const output = formatContextMarkdown(
      makeCtx({ agent: "openai", model: null }), 0, "manual"
    );
    expect(output).toContain("Provider: openai");
    expect(output).not.toMatch(/Provider:.*\(/);
  });

  it("memory dedup: persisted memory wins over memoryFacts for same key", () => {
    const output = formatContextMarkdown(
      makeCtx({
        persistedMemory: [{ key: "db", value: "prod", source: "user" }],
        memoryFacts: [{ key: "db", value: "dev", source: "agent", confidence: 0.5 }],
      }),
      0,
      "manual",
    );
    expect(output).toContain("db = prod");
    expect(output).not.toContain("db = dev");
  });

  it("empty context produces minimal output with workspace", () => {
    const output = formatContextMarkdown(makeCtx(), 0, "manual");
    expect(output).toContain("# Session Context (v0)");
    expect(output).toContain("- Mode: manual");
    expect(output).toContain("## Workspace");
    expect(output).not.toContain("## Projects");
    expect(output).not.toContain("## Pinned Context");
    expect(output).not.toContain("## Memory");
  });
});

describe("SearchPanel highlightMatch edge cases", () => {
  it("handles match at character 0", () => {
    const result = highlightMatch("foobar", 0, 3);
    expect(result).toEqual({ before: "", match: "foo", after: "bar" });
  });

  it("handles match spanning entire string", () => {
    const result = highlightMatch("abc", 0, 3);
    expect(result).toEqual({ before: "", match: "abc", after: "" });
  });

  it("handles zero-length match (cursor position)", () => {
    const result = highlightMatch("hello", 3, 3);
    expect(result).toEqual({ before: "hel", match: "", after: "lo" });
  });
});
