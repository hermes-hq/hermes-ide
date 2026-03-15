/**
 * Tests for worktree path validation — specifically the trailing-slash fix
 * in detectBranchMismatch that prevents false-positive matches on directory
 * name prefixes (e.g. /abc_main vs /abc_main-feature).
 *
 * The FIXED version uses `newCwd.startsWith(entry.cwd + '/')` (or exact match)
 * instead of a bare `newCwd.startsWith(entry.cwd)` so that a CWD of
 * `/worktrees/abc_main` does NOT match `/worktrees/abc_main-feature`.
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

// ─── Helpers: replicate pure logic from pool.ts (FIXED version) ─────

interface PoolEntry {
  cwd: string | null;
}

/**
 * Mirrors detectBranchMismatch() from pool.ts — FIXED version with
 * trailing-slash boundary check to prevent prefix false-positives.
 */
function detectBranchMismatch(
  pool: Map<string, PoolEntry>,
  currentSessionId: string,
  newCwd: string,
): { sessionId: string; branch: string } | null {
  if (!newCwd.includes(".hermes/worktrees/")) return null;

  for (const [sessionId, entry] of pool.entries()) {
    if (sessionId === currentSessionId) continue;
    if (
      entry.cwd &&
      (newCwd === entry.cwd || newCwd.startsWith(entry.cwd + '/')) &&
      entry.cwd.includes(".hermes/worktrees/")
    ) {
      const match = entry.cwd.match(
        /\.hermes\/worktrees\/[^/]+_(.+?)(?:\/|$)/,
      );
      const branch = match?.[1] || "unknown";
      return { sessionId, branch };
    }
  }
  return null;
}

// =====================================================================
// detectBranchMismatch — path boundary (trailing slash fix)
// =====================================================================

describe("detectBranchMismatch — path boundary", () => {
  it("does NOT false-match similar directory names", () => {
    // /abc_main should NOT match /abc_main-feature
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_main",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main-feature/src",
    );
    expect(result).toBeNull();
  });

  it("DOES match exact directory", () => {
    // /abc_main should match /abc_main
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_main",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-2");
    expect(result!.branch).toBe("main");
  });

  it("DOES match subdirectory", () => {
    // /abc_main/src should match /abc_main
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_main",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main/src",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-2");
    expect(result!.branch).toBe("main");
  });

  it("does not match partial prefix without slash", () => {
    // /worktrees/feat should NOT match /worktrees/feature
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_feat",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_feature/src",
    );
    expect(result).toBeNull();
  });

  it("does not match when entry cwd is a prefix of a longer directory name", () => {
    // /worktrees/abc_develop should NOT match /worktrees/abc_develop-v2
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_develop",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_develop-v2",
    );
    expect(result).toBeNull();
  });

  it("matches deeply nested paths under exact worktree", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_feature-login",
    });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_feature-login/src/components/deep/nested",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-2");
    expect(result!.branch).toBe("feature-login");
  });

  it("distinguishes between sibling worktrees with similar names", () => {
    // Two worktrees: abc_main and abc_main-v2. They should NOT cross-match.
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_main",
    });
    pool.set("session-3", {
      cwd: "/Users/dev/project/.hermes/worktrees/abc_main-v2",
    });

    // Navigating into session-3's worktree should match session-3, not session-2
    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main-v2/src",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-3");
    expect(result!.branch).toBe("main-v2");
  });
});
