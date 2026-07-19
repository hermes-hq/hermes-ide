/**
 * Tests for worktree UX improvements in the session creation flow.
 *
 * Covers:
 * - P0#3: Error event emission when worktree creation fails
 * - P1#7: Updated skip-warning text for shared branches
 * - P2#8: Renamed "Skip" / "Skip branches" button labels
 * - P2#9: Renamed "Session is here" taken label to "In use"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
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

import { translate } from "../i18n/registry";

// =====================================================================
// P0#3: Worktree creation error event emission
// =====================================================================

/**
 * Replicates the worktree creation loop from SessionContext.tsx createSession().
 * We extract the pure logic so we can test it without rendering React context.
 *
 * The `emitEvent` callback mirrors window.dispatchEvent(new CustomEvent(...))
 * in the production code, allowing us to capture and verify the event without
 * needing a browser window object.
 */
interface BranchSelection {
  branch: string;
  createNew: boolean;
}

interface WorktreeCreateResult {
  worktreePath: string;
  branchName: string;
  isMainWorktree: boolean;
  isShared?: boolean;
}

interface WorktreeErrorEvent {
  errors: string[];
  sessionLabel?: string;
}

async function simulateWorktreeCreation(
  projectIds: string[],
  branchSelections: Record<string, BranchSelection>,
  createWorktreeFn: (sessionId: string, projectId: string, branch: string, createNew: boolean) => Promise<WorktreeCreateResult>,
  sessionId: string,
  emitEvent: (detail: WorktreeErrorEvent) => void,
  label?: string,
): Promise<{ sharedBranches: string[]; worktreeErrors: string[] }> {
  const sharedBranches: string[] = [];
  const worktreeErrors: string[] = [];

  for (const projectId of projectIds) {
    const sel = branchSelections[projectId];
    if (!sel) continue;
    try {
      const wtResult = await createWorktreeFn(sessionId, projectId, sel.branch, sel.createNew);
      if (wtResult.isShared) {
        sharedBranches.push(sel.branch);
      }
    } catch (wtErr) {
      worktreeErrors.push(`${projectId}: ${wtErr}`);
    }
  }

  // This mirrors the production code:
  //   window.dispatchEvent(new CustomEvent("hermes:worktree-errors", {
  //     detail: { errors: worktreeErrors, sessionLabel: opts?.label },
  //   }));
  if (worktreeErrors.length > 0) {
    emitEvent({ errors: worktreeErrors, sessionLabel: label });
  }

  return { sharedBranches, worktreeErrors };
}

describe("P0#3: Worktree creation failure emits error event", () => {
  let emittedEvent: WorktreeErrorEvent | null = null;
  const captureEvent = (detail: WorktreeErrorEvent) => {
    emittedEvent = detail;
  };

  beforeEach(() => {
    emittedEvent = null;
  });

  it("emits worktree-errors event when a project fails", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate
      .mockResolvedValueOnce({ worktreePath: "/tmp/wt1", branchName: "feat-a", isMainWorktree: false })
      .mockRejectedValueOnce(new Error("branch conflict"));

    const result = await simulateWorktreeCreation(
      ["proj-1", "proj-2"],
      {
        "proj-1": { branch: "feat-a", createNew: false },
        "proj-2": { branch: "feat-b", createNew: true },
      },
      mockCreate,
      "session-abc",
      captureEvent,
      "My Session",
    );

    expect(result.worktreeErrors).toHaveLength(1);
    expect(result.worktreeErrors[0]).toContain("proj-2");
    expect(result.worktreeErrors[0]).toContain("branch conflict");

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent!.errors).toHaveLength(1);
    expect(emittedEvent!.errors[0]).toContain("proj-2");
    expect(emittedEvent!.sessionLabel).toBe("My Session");
  });

  it("does NOT emit event when all worktrees succeed", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate.mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "main", isMainWorktree: false });

    const result = await simulateWorktreeCreation(
      ["proj-1"],
      { "proj-1": { branch: "main", createNew: false } },
      mockCreate,
      "session-xyz",
      captureEvent,
    );

    expect(result.worktreeErrors).toHaveLength(0);
    expect(emittedEvent).toBeNull();
  });

  it("collects errors from multiple failing projects", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("lock conflict"));

    const result = await simulateWorktreeCreation(
      ["proj-a", "proj-b"],
      {
        "proj-a": { branch: "dev", createNew: false },
        "proj-b": { branch: "staging", createNew: false },
      },
      mockCreate,
      "session-multi",
      captureEvent,
      "Multi-Project",
    );

    expect(result.worktreeErrors).toHaveLength(2);
    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent!.errors).toHaveLength(2);
    expect(emittedEvent!.errors[0]).toContain("proj-a");
    expect(emittedEvent!.errors[1]).toContain("proj-b");
    expect(emittedEvent!.sessionLabel).toBe("Multi-Project");
  });

  it("tracks shared branches correctly alongside errors", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate
      .mockResolvedValueOnce({ worktreePath: "/tmp/wt", branchName: "shared", isMainWorktree: false, isShared: true })
      .mockRejectedValueOnce(new Error("oops"));

    const result = await simulateWorktreeCreation(
      ["proj-1", "proj-2"],
      {
        "proj-1": { branch: "shared", createNew: false },
        "proj-2": { branch: "other", createNew: false },
      },
      mockCreate,
      "session-mix",
      captureEvent,
    );

    expect(result.sharedBranches).toEqual(["shared"]);
    expect(result.worktreeErrors).toHaveLength(1);
    expect(emittedEvent).not.toBeNull();
  });

  it("skips projects without branch selections", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate.mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "main", isMainWorktree: false });

    await simulateWorktreeCreation(
      ["proj-1", "proj-2", "proj-3"],
      { "proj-1": { branch: "main", createNew: false } },
      mockCreate,
      "session-partial",
      captureEvent,
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(emittedEvent).toBeNull();
  });

  it("includes sessionLabel as undefined when not provided", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate.mockRejectedValue(new Error("fail"));

    await simulateWorktreeCreation(
      ["proj-1"],
      { "proj-1": { branch: "main", createNew: false } },
      mockCreate,
      "session-no-label",
      captureEvent,
      // label intentionally omitted
    );

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent!.sessionLabel).toBeUndefined();
  });

  it("error message includes project ID and error text", async () => {
    const mockCreate = vi.fn<[string, string, string, boolean], Promise<WorktreeCreateResult>>();
    mockCreate.mockRejectedValueOnce(new Error("Permission denied"));

    const result = await simulateWorktreeCreation(
      ["my-project-abc"],
      { "my-project-abc": { branch: "feature", createNew: true } },
      mockCreate,
      "session-err",
      captureEvent,
      "Test Session",
    );

    expect(result.worktreeErrors[0]).toBe("my-project-abc: Error: Permission denied");
    expect(emittedEvent!.errors[0]).toBe("my-project-abc: Error: Permission denied");
  });
});

// =====================================================================
// P1#7: Skip-warning text update
// =====================================================================

describe("P1#7: Shared branch warning text", () => {
  it("SessionBranchSelector source contains shared-branch warning as tooltip", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(__dirname, "../components/SessionBranchSelector.tsx");
    const source = fs.readFileSync(filePath, "utf-8");

    // Warning moved to tooltip on "Use current branch" button.  The copy
    // now lives in the language packs; the source wires the i18n key into
    // the button's title — assert both ends of the contract.
    expect(source).toContain('title={t("branch.useCurrentHint")}');
    expect(translate("branch.useCurrentHint")).toContain("changes will be shared");
    // Old inline warning block should be gone
    expect(source).not.toContain(
      "Skipping means this session will share the working directory"
    );
  });
});

// =====================================================================
// P2#8: Renamed Skip / Skip branches buttons
// =====================================================================

describe("P2#8: Button label renames", () => {
  it("SessionBranchSelector uses 'Use current branch' instead of 'Skip'", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(__dirname, "../components/SessionBranchSelector.tsx");
    const source = fs.readFileSync(filePath, "utf-8");

    // The word "Skip" should NOT appear as button text in JSX
    // (it may still appear in comments, CSS class names, or variable names)
    const skipButtonPattern = />\s*Skip\s*</;
    expect(source).not.toMatch(skipButtonPattern);

    // New label should be present
    expect(source).toContain("Use current branch");
  });

  it("SessionCreator uses 'Continue without isolation' instead of 'Skip branches'", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(__dirname, "../components/SessionCreator.tsx");
    const source = fs.readFileSync(filePath, "utf-8");

    // The label moved behind an i18n key — pin the key and the English copy.
    expect(source).toContain("session.continueWithoutIsolation");
    expect(translate("session.continueWithoutIsolation")).toBe("Continue without isolation");
    expect(source).not.toContain("Skip branches");
  });

  it("SessionCreator branch step has a subtitle explaining isolation", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(__dirname, "../components/SessionCreator.tsx");
    const source = fs.readFileSync(filePath, "utf-8");

    // The subtitle renders via the session.selectBranchesHint key.
    expect(source).toContain("session.selectBranchesHint");
    expect(translate("session.selectBranchesHint")).toContain(
      "Each project gets its own isolated branch so changes in this session don't affect other sessions."
    );
  });
});

// =====================================================================
// P2#9: Renamed "Session is here" taken label
// =====================================================================

describe("P2#9: Taken branch label", () => {
  it("SessionBranchSelector uses 'In use' instead of 'Session is here'", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(__dirname, "../components/SessionBranchSelector.tsx");
    const source = fs.readFileSync(filePath, "utf-8");

    expect(source).toContain("in use");
    expect(source).not.toContain("Session is here");
  });
});
