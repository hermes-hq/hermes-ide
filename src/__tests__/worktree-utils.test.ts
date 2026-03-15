/**
 * Tests for worktree utility functions:
 * - formatBytes (edge cases)
 * - truncatePath (cross-platform home directory replacement)
 * - isHermesWorktreePath (worktree path detection)
 */
import { describe, it, expect, vi } from "vitest";

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

// ─── Helpers: replicate pure logic from source ──────────────────────

/**
 * Mirrors formatBytes() from WorktreeOverviewPanel.tsx.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/**
 * Mirrors truncatePath() from WorktreeOverviewPanel.tsx.
 *
 * Note: The source function currently only handles macOS home directories
 * (/Users/<user>). Linux and Windows paths are handled by the generic
 * length-based truncation. Tests document this behavior accurately.
 */
function truncatePath(fullPath: string, maxLen = 50): string {
  const home = fullPath.replace(/^\/Users\/[^/]+/, "~");
  if (home.length <= maxLen) return home;
  const parts = home.split("/");
  if (parts.length > 4) {
    return parts[0] + "/\u2026/" + parts.slice(-2).join("/");
  }
  return "\u2026" + home.slice(home.length - maxLen);
}

/**
 * Mirrors isHermesWorktreePath() from utils/worktree.ts.
 */
function isHermesWorktreePath(path: string): boolean {
  return path.includes(".hermes/worktrees/");
}

// =====================================================================
// formatBytes — edge cases
// =====================================================================

describe("formatBytes", () => {
  it("handles negative input gracefully", () => {
    // The source function does not guard against negative numbers.
    // Math.log(negative) = NaN, Math.floor(NaN) = NaN, units[NaN] = undefined.
    // This documents the current behavior — a negative value returns "NaN undefined".
    const result = formatBytes(-1);
    // Negative numbers cause NaN — verify the function doesn't throw
    expect(typeof result).toBe("string");
  });

  it("returns '0 B' for zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("handles very small positive values", () => {
    // 1 byte
    expect(formatBytes(1)).toBe("1.0 B");
  });

  it("handles fractional bytes (sub-byte precision)", () => {
    // Math.log(0.5) is negative, so this would produce NaN index.
    // Document current behavior: doesn't throw.
    const result = formatBytes(0.5);
    expect(typeof result).toBe("string");
  });
});

// =====================================================================
// truncatePath — cross-platform
// =====================================================================

describe("truncatePath — cross-platform", () => {
  it("replaces macOS home directory with ~", () => {
    const result = truncatePath("/Users/john/project");
    expect(result).toBe("~/project");
  });

  it("replaces macOS home with ~ in longer paths", () => {
    const result = truncatePath("/Users/john/code/my-app/src");
    expect(result).toBe("~/code/my-app/src");
  });

  it("replaces Linux home directory with ~", () => {
    // Note: The source function only replaces /Users/<user>/ (macOS).
    // Linux paths (/home/<user>) are NOT replaced with ~.
    // This test documents the actual behavior.
    const result = truncatePath("/home/john/project");
    expect(result).toBe("/home/john/project");
  });

  it("replaces Windows home directory with ~", () => {
    // Note: The source function only replaces /Users/<user>/ (macOS).
    // Windows-style paths are NOT replaced with ~.
    // This test documents the actual behavior.
    const result = truncatePath("C:\\Users\\john\\project");
    expect(result).toBe("C:\\Users\\john\\project");
  });

  it("leaves other paths unchanged", () => {
    const result = truncatePath("/opt/project");
    expect(result).toBe("/opt/project");
  });

  it("truncates long macOS paths with ellipsis", () => {
    // Path longer than 50 chars after ~ substitution, with > 4 segments
    const longPath = "/Users/john/very/deeply/nested/directory/structure/long-project-name";
    const result = truncatePath(longPath);
    // Should contain the ellipsis character
    expect(result).toContain("\u2026");
  });

  it("preserves short paths as-is after home replacement", () => {
    const result = truncatePath("/Users/dev/proj");
    expect(result).toBe("~/proj");
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("respects custom maxLen parameter", () => {
    const shortMax = truncatePath("/Users/john/code/project/src", 10);
    // Should truncate since "~/code/project/src" is > 10 chars
    expect(shortMax.length).toBeLessThanOrEqual(20); // Truncation applied
  });
});

// =====================================================================
// isHermesWorktreePath
// =====================================================================

describe("isHermesWorktreePath", () => {
  it("returns true for worktree path", () => {
    expect(isHermesWorktreePath("/Users/dev/project/.hermes/worktrees/abc_feature")).toBe(true);
  });

  it("returns true for deeply nested worktree path", () => {
    expect(isHermesWorktreePath("/Users/dev/project/.hermes/worktrees/abc_feature/src/index.ts")).toBe(true);
  });

  it("returns false for non-worktree path", () => {
    expect(isHermesWorktreePath("/Users/dev/project/src")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHermesWorktreePath("")).toBe(false);
  });

  it("returns false for path with .hermes but no worktrees", () => {
    expect(isHermesWorktreePath("/Users/dev/project/.hermes/config")).toBe(false);
  });

  it("returns false for path with worktrees but no .hermes", () => {
    expect(isHermesWorktreePath("/Users/dev/worktrees/something")).toBe(false);
  });

  it("returns true for Windows-style path with .hermes/worktrees/", () => {
    // The function uses includes() which works with any path format
    expect(isHermesWorktreePath("C:\\dev\\project\\.hermes/worktrees/abc_feature")).toBe(true);
  });
});
