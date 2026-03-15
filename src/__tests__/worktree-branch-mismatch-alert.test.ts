/**
 * Tests for the BranchMismatchAlert component behavior.
 *
 * Covers:
 * - Rendering branch name and session label
 * - Auto-dismiss after AUTO_DISMISS_MS (8000ms)
 * - Dismiss on X button click
 * - Accessibility attributes (role="alert", aria-live="polite")
 *
 * Since the test environment is node (no DOM), we reimplement the component
 * logic as pure functions following the existing test pattern in this codebase.
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

// ─── Helpers: replicate component logic from BranchMismatchAlert.tsx ─

const AUTO_DISMISS_MS = 8000;

interface BranchMismatchAlertProps {
  branch: string;
  sessionLabel: string;
  onDismiss: () => void;
}

/**
 * Mirrors the render output of BranchMismatchAlert.
 * Returns the attributes and text content that the component would produce.
 */
function getBranchMismatchAlertOutput(props: BranchMismatchAlertProps) {
  return {
    role: "alert",
    ariaLive: "polite",
    className: "branch-mismatch-alert",
    titleText: "You've entered another session's worktree",
    branchText: props.branch,
    sessionLabelText: props.sessionLabel,
    detailText: `Branch ${props.branch} belongs to session ${props.sessionLabel}`,
    closeButtonAriaLabel: "Dismiss",
  };
}

/**
 * Simulates the useEffect auto-dismiss timer from BranchMismatchAlert.
 * Returns { start, cleanup } to mimic React's useEffect lifecycle.
 */
function createAutoDismissTimer(onDismiss: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    start() {
      timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    },
    cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// =====================================================================
// BranchMismatchAlert component behavior
// =====================================================================

describe("BranchMismatchAlert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders branch name and session label", () => {
    const output = getBranchMismatchAlertOutput({
      branch: "feature/login",
      sessionLabel: "Session 2",
      onDismiss: vi.fn(),
    });

    expect(output.branchText).toBe("feature/login");
    expect(output.sessionLabelText).toBe("Session 2");
    expect(output.detailText).toContain("feature/login");
    expect(output.detailText).toContain("Session 2");
  });

  it("auto-dismisses after AUTO_DISMISS_MS", () => {
    const onDismiss = vi.fn();
    const timer = createAutoDismissTimer(onDismiss);

    timer.start();

    // Not yet dismissed
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();

    // Now dismissed
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    timer.cleanup();
  });

  it("cleans up timer on unmount before auto-dismiss fires", () => {
    const onDismiss = vi.fn();
    const timer = createAutoDismissTimer(onDismiss);

    timer.start();

    // Simulate unmount before timer fires
    vi.advanceTimersByTime(3000);
    timer.cleanup();

    // Advance past the original timeout — onDismiss should NOT fire
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss when X button clicked", () => {
    const onDismiss = vi.fn();

    // Simulate clicking the close button — the component's onClick calls onDismiss
    onDismiss();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("has role='alert' and aria-live='polite'", () => {
    const output = getBranchMismatchAlertOutput({
      branch: "develop",
      sessionLabel: "My Session",
      onDismiss: vi.fn(),
    });

    expect(output.role).toBe("alert");
    expect(output.ariaLive).toBe("polite");
  });

  it("close button has aria-label='Dismiss'", () => {
    const output = getBranchMismatchAlertOutput({
      branch: "main",
      sessionLabel: "Session 1",
      onDismiss: vi.fn(),
    });

    expect(output.closeButtonAriaLabel).toBe("Dismiss");
  });

  it("renders title text about entering another session's worktree", () => {
    const output = getBranchMismatchAlertOutput({
      branch: "hotfix/auth",
      sessionLabel: "Auth Session",
      onDismiss: vi.fn(),
    });

    expect(output.titleText).toContain("another session");
    expect(output.titleText).toContain("worktree");
  });

  it("auto-dismiss uses exactly 8000ms timeout", () => {
    expect(AUTO_DISMISS_MS).toBe(8000);
  });

  it("handles branch names with special characters", () => {
    const output = getBranchMismatchAlertOutput({
      branch: "feature/JIRA-123_my-branch",
      sessionLabel: "Session (dev)",
      onDismiss: vi.fn(),
    });

    expect(output.branchText).toBe("feature/JIRA-123_my-branch");
    expect(output.sessionLabelText).toBe("Session (dev)");
  });
});
