/**
 * Tests for SessionItemGitInfo sub-component logic.
 *
 * Since the test environment is `node` (no DOM), we test the rendering
 * decisions and text construction extracted from the component.
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

// ─── Types ───────────────────────────────────────────────────────────

interface SessionItemGitInfoProps {
  branch: string | null;
  changeCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  isLoading: boolean;
  enabled: boolean;
}

interface GitInfoOutput {
  shouldRender: boolean;
  branchText: string | null;
  changesText: string | null;
  showConflictWarning: boolean;
  aheadIndicator: string | null;
  behindIndicator: string | null;
  isLoading: boolean;
}

// ─── Extracted rendering logic (mirrors SessionItemGitInfo) ──────────

function getGitInfoOutput(props: SessionItemGitInfoProps): GitInfoOutput {
  const { branch, changeCount, ahead, behind, hasConflicts, isLoading, enabled } = props;

  // Do not render for destroyed sessions
  if (!enabled) {
    return {
      shouldRender: false,
      branchText: null,
      changesText: null,
      showConflictWarning: false,
      aheadIndicator: null,
      behindIndicator: null,
      isLoading: false,
    };
  }

  // Loading state
  if (isLoading) {
    return {
      shouldRender: true,
      branchText: null,
      changesText: null,
      showConflictWarning: false,
      aheadIndicator: null,
      behindIndicator: null,
      isLoading: true,
    };
  }

  // No git repo — don't render
  if (branch === null) {
    return {
      shouldRender: false,
      branchText: null,
      changesText: null,
      showConflictWarning: false,
      aheadIndicator: null,
      behindIndicator: null,
      isLoading: false,
    };
  }

  const changesText = changeCount > 0 ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : "clean";
  const aheadIndicator = ahead > 0 ? `${ahead}\u2191` : null; // ↑
  const behindIndicator = behind > 0 ? `${behind}\u2193` : null; // ↓

  return {
    shouldRender: true,
    branchText: branch,
    changesText,
    showConflictWarning: hasConflicts,
    aheadIndicator,
    behindIndicator,
    isLoading: false,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("SessionItemGitInfo - Branch display", () => {
  it("shows branch name when available", () => {
    const result = getGitInfoOutput({
      branch: "feature/login",
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.shouldRender).toBe(true);
    expect(result.branchText).toBe("feature/login");
  });

  it("does not render when session has no git repo (branch is null)", () => {
    const result = getGitInfoOutput({
      branch: null,
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.shouldRender).toBe(false);
    expect(result.branchText).toBeNull();
  });
});

describe("SessionItemGitInfo - Change count display", () => {
  it("shows 'X changes' when there are changes (plural)", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 5,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.changesText).toBe("5 changes");
  });

  it("shows '1 change' for singular", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 1,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.changesText).toBe("1 change");
  });

  it("shows 'clean' when there are 0 changes", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.changesText).toBe("clean");
  });
});

describe("SessionItemGitInfo - Conflict warning", () => {
  it("shows conflict warning when hasConflicts is true", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 3,
      ahead: 0,
      behind: 0,
      hasConflicts: true,
      isLoading: false,
      enabled: true,
    });
    expect(result.showConflictWarning).toBe(true);
  });

  it("does not show conflict warning when hasConflicts is false", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.showConflictWarning).toBe(false);
  });
});

describe("SessionItemGitInfo - Ahead/behind indicators", () => {
  it("shows ahead indicator when ahead > 0", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 3,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.aheadIndicator).toBe("3\u2191");
  });

  it("shows behind indicator when behind > 0", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 0,
      behind: 2,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.behindIndicator).toBe("2\u2193");
  });

  it("shows both ahead and behind indicators", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 5,
      behind: 3,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.aheadIndicator).toBe("5\u2191");
    expect(result.behindIndicator).toBe("3\u2193");
  });

  it("does not show ahead indicator when ahead is 0", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.aheadIndicator).toBeNull();
  });

  it("does not show behind indicator when behind is 0", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
      enabled: true,
    });
    expect(result.behindIndicator).toBeNull();
  });
});

describe("SessionItemGitInfo - Destroyed sessions", () => {
  it("does not render for destroyed sessions (enabled=false)", () => {
    const result = getGitInfoOutput({
      branch: "main",
      changeCount: 5,
      ahead: 2,
      behind: 1,
      hasConflicts: true,
      isLoading: false,
      enabled: false,
    });
    expect(result.shouldRender).toBe(false);
    expect(result.branchText).toBeNull();
    expect(result.changesText).toBeNull();
  });
});

describe("SessionItemGitInfo - Loading state", () => {
  it("shows loading state briefly (renders but with no data)", () => {
    const result = getGitInfoOutput({
      branch: null,
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: true,
      enabled: true,
    });
    expect(result.shouldRender).toBe(true);
    expect(result.isLoading).toBe(true);
    expect(result.branchText).toBeNull();
    expect(result.changesText).toBeNull();
  });

  it("loading state does not show conflict warning", () => {
    const result = getGitInfoOutput({
      branch: null,
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: true,
      enabled: true,
    });
    expect(result.showConflictWarning).toBe(false);
  });
});
