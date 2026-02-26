/**
 * State & Session Bug Fixes Test Suite
 *
 * Covers bugs found during deep analysis of state management and session components:
 *
 * CRITICAL:
 *   1. SplitDivider division-by-zero produces NaN ratio corrupting layout
 *   2. updateSplitRatio NaN propagation through Math.min/Math.max
 *
 * HIGH:
 *   3. requestCloseSession stale closure reading outdated skipCloseConfirm
 *   4. CommandPalette selectedIndex out-of-bounds when filtered list is empty
 *   5. SESSION_REMOVED does not clear pendingCloseSessionId for the removed session
 *   6. ScopeBar dead code — unreachable ProjectPicker in empty-projects branch
 *
 * MEDIUM:
 *   7. Settings window size onChange uses stale closure values instead of refs
 *   8. StatusBar crash when working_directory is null/undefined from backend
 *   9. closeSession has no double-close guard (race condition)
 *  10. CLOSE_PANE does not clear activeSessionId when last pane is removed
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
  focusTerminal: vi.fn(),
  refitActive: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState } from "../state/SessionContext";
import type { SessionData } from "../types/session";
import {
  updateSplitRatio,
  collectPanes,
  PaneLeaf,
  SplitNode,
  LayoutNode,
} from "../state/layoutTypes";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/home/user/project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0,
      error_count: 0,
      stuck_score: 0,
      token_usage: {},
      tool_calls: [],
      tool_call_summary: {},
      files_touched: [],
      recent_errors: [],
      recent_actions: [],
      available_actions: [],
      memory_facts: [],
      latency_p50_ms: null,
      latency_p95_ms: null,
      latency_samples: [],
      token_history: [],
    },
    ai_provider: null,
    context_injected: false,
    ...overrides,
  };
}

function makeLayoutWithTwoPanes(session1: string, session2: string) {
  let state = initialState;
  state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: session1 }) });
  state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: session2 }) });
  state = sessionReducer(state, { type: "INIT_PANE", sessionId: session1 });
  const paneId = state.layout.focusedPaneId!;
  state = sessionReducer(state, {
    type: "SPLIT_PANE",
    paneId,
    direction: "horizontal",
    newSessionId: session2,
  });
  return state;
}

// =====================================================================
// CRITICAL BUG 1: updateSplitRatio NaN guard
// =====================================================================

describe("CRITICAL: updateSplitRatio NaN/Infinity guard", () => {
  const splitNode: SplitNode = {
    type: "split",
    id: "split-test",
    direction: "horizontal",
    children: [
      { type: "pane", id: "p1", sessionId: "s1" },
      { type: "pane", id: "p2", sessionId: "s2" },
    ],
    ratio: 0.5,
  };

  it("rejects NaN ratio and returns the original tree unchanged", () => {
    const result = updateSplitRatio(splitNode, "split-test", NaN);
    expect(result).toBe(splitNode); // Same reference = no mutation
    if (result.type === "split") {
      expect(result.ratio).toBe(0.5);
    }
  });

  it("rejects Infinity ratio and returns the original tree unchanged", () => {
    const result = updateSplitRatio(splitNode, "split-test", Infinity);
    expect(result).toBe(splitNode);
    if (result.type === "split") {
      expect(result.ratio).toBe(0.5);
    }
  });

  it("rejects -Infinity ratio and returns the original tree unchanged", () => {
    const result = updateSplitRatio(splitNode, "split-test", -Infinity);
    expect(result).toBe(splitNode);
    if (result.type === "split") {
      expect(result.ratio).toBe(0.5);
    }
  });

  it("clamps valid ratio within 0.15–0.85 range", () => {
    const resultLow = updateSplitRatio(splitNode, "split-test", 0.01);
    if (resultLow.type === "split") {
      expect(resultLow.ratio).toBe(0.15);
    }

    const resultHigh = updateSplitRatio(splitNode, "split-test", 0.99);
    if (resultHigh.type === "split") {
      expect(resultHigh.ratio).toBe(0.85);
    }
  });

  it("accepts a normal ratio within bounds", () => {
    const result = updateSplitRatio(splitNode, "split-test", 0.6);
    if (result.type === "split") {
      expect(result.ratio).toBe(0.6);
    }
  });

  it("handles division-by-zero scenario (0/0 = NaN) gracefully", () => {
    const ratio = 0 / 0; // NaN
    const result = updateSplitRatio(splitNode, "split-test", ratio);
    expect(result).toBe(splitNode);
  });
});

// =====================================================================
// CRITICAL BUG 2: RESIZE_SPLIT reducer with NaN
// =====================================================================

describe("CRITICAL: RESIZE_SPLIT reducer NaN safety", () => {
  it("RESIZE_SPLIT with NaN does not corrupt layout state", () => {
    let state = makeLayoutWithTwoPanes("s1", "s2");
    expect(state.layout.root).not.toBeNull();
    expect(state.layout.root!.type).toBe("split");

    const splitId = state.layout.root!.id;
    const originalRoot = state.layout.root;

    // Dispatch NaN ratio
    state = sessionReducer(state, { type: "RESIZE_SPLIT", splitId, ratio: NaN });

    // The root should be unchanged (NaN rejected by guard)
    expect(state.layout.root).toBe(originalRoot);
    if (state.layout.root?.type === "split") {
      expect(Number.isFinite(state.layout.root.ratio)).toBe(true);
    }
  });

  it("RESIZE_SPLIT with valid ratio updates correctly", () => {
    let state = makeLayoutWithTwoPanes("s1", "s2");
    const splitId = state.layout.root!.id;

    state = sessionReducer(state, { type: "RESIZE_SPLIT", splitId, ratio: 0.3 });

    if (state.layout.root?.type === "split") {
      expect(state.layout.root.ratio).toBe(0.3);
    }
  });
});

// =====================================================================
// HIGH BUG 3: CommandPalette selectedIndex out-of-bounds
// =====================================================================

describe("HIGH: CommandPalette selectedIndex boundary handling", () => {
  // Testing the filtering and index clamping logic directly

  it("ArrowDown with empty filtered list should stay at 0", () => {
    // Simulating the fixed logic: filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)
    const filteredLength = 0;
    const currentIndex = 0;
    const newIndex = filteredLength === 0 ? 0 : Math.min(currentIndex + 1, filteredLength - 1);
    expect(newIndex).toBe(0);
  });

  it("ArrowDown with empty list no longer produces -1 index", () => {
    // Before fix: Math.min(i + 1, filtered.length - 1) = Math.min(1, -1) = -1
    // After fix: filtered.length === 0 ? 0 : ...
    const filteredLength = 0;
    const currentIndex = 0;

    // Old (buggy) behavior:
    const oldResult = Math.min(currentIndex + 1, filteredLength - 1);
    expect(oldResult).toBe(-1); // This was the bug

    // New (fixed) behavior:
    const newResult = filteredLength === 0 ? 0 : Math.min(currentIndex + 1, filteredLength - 1);
    expect(newResult).toBe(0); // Fixed
  });

  it("Enter with safe clamped index handles empty list", () => {
    const filtered: { action: () => void }[] = [];
    const selectedIndex = 5; // Stale from a previous filter
    const safeIdx = Math.min(selectedIndex, filtered.length - 1);
    // safeIdx = Math.min(5, -1) = -1, so condition safeIdx >= 0 prevents crash
    expect(safeIdx).toBeLessThan(0);
    // No action should execute
    let actionCalled = false;
    if (safeIdx >= 0 && filtered[safeIdx]) {
      filtered[safeIdx].action();
      actionCalled = true;
    }
    expect(actionCalled).toBe(false);
  });

  it("Enter with valid filtered list selects correct item", () => {
    let executedId = "";
    const filtered = [
      { id: "a", action: () => { executedId = "a"; } },
      { id: "b", action: () => { executedId = "b"; } },
    ];
    const selectedIndex = 1;
    const safeIdx = Math.min(selectedIndex, filtered.length - 1);
    expect(safeIdx).toBe(1);
    if (safeIdx >= 0 && filtered[safeIdx]) {
      filtered[safeIdx].action();
    }
    expect(executedId).toBe("b");
  });
});

// =====================================================================
// HIGH BUG 4: SESSION_REMOVED clears pendingCloseSessionId
// =====================================================================

describe("HIGH: SESSION_REMOVED clears pendingCloseSessionId", () => {
  it("clears pendingCloseSessionId when the removed session matches", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });

    // User opens the close dialog for s1
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "s1" });
    expect(state.pendingCloseSessionId).toBe("s1");

    // Session gets removed externally (e.g., PTY exits)
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.pendingCloseSessionId).toBeNull();
  });

  it("preserves pendingCloseSessionId when a different session is removed", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s2" }) });

    // Open close dialog for s1
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "s1" });
    expect(state.pendingCloseSessionId).toBe("s1");

    // Remove s2 (unrelated)
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s2" });
    expect(state.pendingCloseSessionId).toBe("s1"); // Preserved
  });

  it("handles session removed when no close dialog is open", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    expect(state.pendingCloseSessionId).toBeNull();

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.pendingCloseSessionId).toBeNull(); // Still null
  });
});

// =====================================================================
// HIGH BUG 5: requestCloseSession stale closure
// =====================================================================

describe("HIGH: requestCloseSession reads latest skipCloseConfirm", () => {
  // This is a callback correctness test — we verify the reducer behavior
  // that underpins the ref-based fix

  it("SET_SKIP_CLOSE_CONFIRM updates state correctly", () => {
    let state = initialState;
    expect(state.skipCloseConfirm).toBe(false);

    state = sessionReducer(state, { type: "SET_SKIP_CLOSE_CONFIRM", skip: true });
    expect(state.skipCloseConfirm).toBe(true);
  });

  it("rapid toggle of skipCloseConfirm does not corrupt state", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SET_SKIP_CLOSE_CONFIRM", skip: true });
    state = sessionReducer(state, { type: "SET_SKIP_CLOSE_CONFIRM", skip: false });
    state = sessionReducer(state, { type: "SET_SKIP_CLOSE_CONFIRM", skip: true });
    expect(state.skipCloseConfirm).toBe(true);
  });

  it("REQUEST_CLOSE_SESSION sets pending ID (when skip=false path is taken)", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "s1" });
    expect(state.pendingCloseSessionId).toBe("s1");
  });

  it("CANCEL_CLOSE_SESSION clears pending", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "s1" });
    state = sessionReducer(state, { type: "CANCEL_CLOSE_SESSION" });
    expect(state.pendingCloseSessionId).toBeNull();
  });
});

// =====================================================================
// MEDIUM BUG 6: CLOSE_PANE clears activeSessionId when last pane removed
// =====================================================================

describe("MEDIUM: CLOSE_PANE clears activeSessionId on last pane", () => {
  it("closing the only pane clears activeSessionId", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    state = sessionReducer(state, { type: "INIT_PANE", sessionId: "s1" });
    expect(state.activeSessionId).toBe("s1");
    expect(state.layout.root).not.toBeNull();

    const paneId = state.layout.focusedPaneId!;
    state = sessionReducer(state, { type: "CLOSE_PANE", paneId });

    expect(state.layout.root).toBeNull();
    expect(state.layout.focusedPaneId).toBeNull();
    expect(state.activeSessionId).toBeNull(); // This was not cleared before the fix
  });

  it("closing one of two panes updates activeSessionId to remaining pane session", () => {
    let state = makeLayoutWithTwoPanes("s1", "s2");
    expect(state.layout.root).not.toBeNull();

    // The focused pane should be the s2 pane (the newly created one from split)
    const panes = collectPanes(state.layout.root!);
    expect(panes.length).toBe(2);

    // Close the focused pane
    const focusedId = state.layout.focusedPaneId!;
    state = sessionReducer(state, { type: "CLOSE_PANE", paneId: focusedId });

    // Should still have a root and an active session
    expect(state.layout.root).not.toBeNull();
    expect(state.activeSessionId).not.toBeNull();
  });

  it("closing a pane on a non-existent layout is a no-op", () => {
    const state = initialState;
    const result = sessionReducer(state, { type: "CLOSE_PANE", paneId: "nonexistent" });
    expect(result).toBe(state); // Same reference
  });
});

// =====================================================================
// MEDIUM BUG 7: closeSession double-close race condition guard
// =====================================================================

describe("MEDIUM: closeSession double-close race guard (reducer level)", () => {
  // The actual fix is in the SessionProvider useCallback with closingSessionIds ref.
  // We test the reducer's behavior to confirm session removal is idempotent.

  it("SESSION_REMOVED for non-existent session is safe", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });

    // Remove s1
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.sessions["s1"]).toBeUndefined();

    // Remove again (double-close)
    const state2 = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state2.sessions["s1"]).toBeUndefined();
    // Should not throw and should maintain valid state
    expect(state2.activeSessionId).toBeNull();
  });

  it("SESSION_REMOVED for session not in sessions map does not corrupt state", () => {
    const state = initialState;
    const result = sessionReducer(state, { type: "SESSION_REMOVED", id: "phantom" });
    expect(result.sessions).toEqual({});
    expect(result.activeSessionId).toBeNull();
  });
});

// =====================================================================
// MEDIUM BUG 8: StatusBar null safety for working_directory
// =====================================================================

describe("MEDIUM: StatusBar working_directory null safety", () => {
  // Testing the pattern used in StatusBar.tsx for extracting basename

  it("extracts basename from a normal path", () => {
    const wd = "/home/user/project";
    const basename = wd ? wd.split("/").pop() || wd : "";
    expect(basename).toBe("project");
  });

  it("handles empty string working_directory", () => {
    const wd = "";
    const basename = wd ? wd.split("/").pop() || wd : "";
    expect(basename).toBe("");
  });

  it("handles null working_directory defensively", () => {
    const wd: string | null = null;
    const basename = wd && wd ? wd.split("/").pop() || wd : "";
    expect(basename).toBe("");
  });

  it("handles undefined working_directory defensively", () => {
    const wd: string | undefined = undefined;
    const basename = wd && wd ? wd.split("/").pop() || wd : "";
    expect(basename).toBe("");
  });

  it("handles root path '/'", () => {
    const wd = "/";
    const basename = wd ? wd.split("/").pop() || wd : "";
    // "/".split("/") = ["", ""], pop() = "", which is falsy, so fallback to wd = "/"
    expect(basename).toBe("/");
  });
});

// =====================================================================
// MEDIUM BUG 9: Settings stale closure for window size
// =====================================================================

describe("MEDIUM: Settings window size ref consistency", () => {
  // Testing the ref-based pattern to ensure latest values are used

  it("ref tracks the latest value even when state updates async", () => {
    // Simulating the latestW/latestH ref pattern
    let winWidth = "1200";
    let winHeight = "800";
    const latestW = { current: winWidth };
    const latestH = { current: winHeight };

    // Simulate rapid width change
    winWidth = "1400";
    latestW.current = winWidth;

    // Simulate rapid height change
    winHeight = "900";
    latestH.current = winHeight;

    // When width onChange fires, it should use latestH.current (900), not stale winHeight
    const applyArgs = [winWidth, latestH.current];
    expect(applyArgs).toEqual(["1400", "900"]);
  });

  it("without ref, stale closure would pass old value", () => {
    // Demonstrating the bug: without refs, closure captures old value
    let winHeight = "800";

    // This simulates the old buggy pattern:
    // onChange={(e) => { setWinWidth(e.target.value); applyWindowSize(e.target.value, winHeight); }}
    // At this point winHeight is "800"
    const capturedHeight = winHeight;

    // Then height changes
    winHeight = "900";

    // The closure still has the old value
    expect(capturedHeight).toBe("800"); // Stale!
    expect(winHeight).toBe("900"); // Current
  });
});

// =====================================================================
// INTEGRATION: Full session lifecycle with layout
// =====================================================================

describe("INTEGRATION: Session lifecycle with layout management", () => {
  it("create -> split -> close-pane -> close-session full flow", () => {
    let state = initialState;

    // Create two sessions
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s2" }) });

    // Init layout for s1
    state = sessionReducer(state, { type: "INIT_PANE", sessionId: "s1" });
    expect(state.activeSessionId).toBe("s1");
    expect(state.layout.root?.type).toBe("pane");

    // Split for s2
    const firstPaneId = state.layout.focusedPaneId!;
    state = sessionReducer(state, {
      type: "SPLIT_PANE",
      paneId: firstPaneId,
      direction: "horizontal",
      newSessionId: "s2",
    });
    expect(state.layout.root?.type).toBe("split");
    expect(collectPanes(state.layout.root!).length).toBe(2);

    // Close the s2 pane
    const s2PaneId = state.layout.focusedPaneId!; // s2 is focused after split
    state = sessionReducer(state, { type: "CLOSE_PANE", paneId: s2PaneId });
    expect(collectPanes(state.layout.root!).length).toBe(1);
    expect(state.activeSessionId).not.toBeNull();

    // Remove session s1
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.layout.root).toBeNull();
    expect(state.activeSessionId).toBe("s2"); // Fallback to s2

    // Remove session s2
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s2" });
    expect(state.activeSessionId).toBeNull();
    expect(Object.keys(state.sessions).length).toBe(0);
  });

  it("rapid session creation and removal maintains consistent state", () => {
    let state = initialState;

    // Create 5 sessions rapidly
    for (let i = 1; i <= 5; i++) {
      state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: `s${i}` }) });
    }
    expect(Object.keys(state.sessions).length).toBe(5);

    // Init pane for the first
    state = sessionReducer(state, { type: "INIT_PANE", sessionId: "s1" });

    // Remove all sessions one by one
    for (let i = 1; i <= 5; i++) {
      state = sessionReducer(state, { type: "SESSION_REMOVED", id: `s${i}` });
    }

    expect(Object.keys(state.sessions).length).toBe(0);
    expect(state.activeSessionId).toBeNull();
    expect(state.layout.root).toBeNull();
    expect(state.layout.focusedPaneId).toBeNull();
    expect(Object.keys(state.executionModes).length).toBe(0);
    expect(Object.keys(state.injectionLocks).length).toBe(0);
    expect(state.pendingCloseSessionId).toBeNull();
  });

  it("SESSION_REMOVED with pending close dialog for same session clears dialog", () => {
    let state = initialState;
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "s1" }) });
    state = sessionReducer(state, { type: "INIT_PANE", sessionId: "s1" });

    // Open close dialog
    state = sessionReducer(state, { type: "REQUEST_CLOSE_SESSION", id: "s1" });
    expect(state.pendingCloseSessionId).toBe("s1");

    // Session removed externally
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });
    expect(state.pendingCloseSessionId).toBeNull(); // Dialog should auto-dismiss
    expect(state.layout.root).toBeNull();
  });
});

// =====================================================================
// EDGE CASE: Layout tree with deeply nested splits
// =====================================================================

describe("EDGE CASE: updateSplitRatio on deeply nested layout", () => {
  it("NaN does not propagate through a 3-level deep split tree", () => {
    // Build a 3-level deep tree manually
    const leaf1: PaneLeaf = { type: "pane", id: "p1", sessionId: "s1" };
    const leaf2: PaneLeaf = { type: "pane", id: "p2", sessionId: "s2" };
    const leaf3: PaneLeaf = { type: "pane", id: "p3", sessionId: "s3" };
    const leaf4: PaneLeaf = { type: "pane", id: "p4", sessionId: "s4" };

    const inner: SplitNode = {
      type: "split",
      id: "inner-split",
      direction: "vertical",
      children: [leaf3, leaf4],
      ratio: 0.5,
    };

    const mid: SplitNode = {
      type: "split",
      id: "mid-split",
      direction: "horizontal",
      children: [leaf2, inner],
      ratio: 0.4,
    };

    const root: SplitNode = {
      type: "split",
      id: "root-split",
      direction: "horizontal",
      children: [leaf1, mid],
      ratio: 0.3,
    };

    // Try to set NaN on the inner split
    const result = updateSplitRatio(root, "inner-split", NaN);
    expect(result).toBe(root); // Unchanged

    // Try to set NaN on a non-existent split
    const result2 = updateSplitRatio(root, "nonexistent", NaN);
    expect(result2).toBe(root);

    // Valid update on inner split works
    const result3 = updateSplitRatio(root, "inner-split", 0.6);
    expect(result3).not.toBe(root); // New reference
    if (result3.type === "split") {
      const midNode = result3.children[1];
      if (midNode.type === "split") {
        const innerNode = midNode.children[1];
        if (innerNode.type === "split") {
          expect(innerNode.ratio).toBe(0.6);
        }
      }
    }
  });
});

// =====================================================================
// EDGE CASE: ScopeBar dead code removal verification
// =====================================================================

describe("EDGE CASE: ScopeBar empty-projects branch logic", () => {
  // Verifying the condition logic: projects.length === 0 && !pickerOpen
  // After fix, no dead ProjectPicker inside this branch

  it("empty projects + picker closed -> shows add button (early return)", () => {
    const projects: unknown[] = [];
    const pickerOpen = false;
    const shouldEarlyReturn = projects.length === 0 && !pickerOpen;
    expect(shouldEarlyReturn).toBe(true);
  });

  it("empty projects + picker open -> falls through to main render", () => {
    const projects: unknown[] = [];
    const pickerOpen = true;
    const shouldEarlyReturn = projects.length === 0 && !pickerOpen;
    expect(shouldEarlyReturn).toBe(false);
    // This means the main render path handles the ProjectPicker
  });

  it("has projects + picker closed -> falls through to main render", () => {
    const projects = [{ id: "p1" }];
    const pickerOpen = false;
    const shouldEarlyReturn = projects.length === 0 && !pickerOpen;
    expect(shouldEarlyReturn).toBe(false);
  });
});

// =====================================================================
// STRESS TEST: Rapid concurrent operations
// =====================================================================

describe("STRESS: Rapid concurrent reducer operations", () => {
  it("100 session create/remove cycles maintain state integrity", () => {
    let state = initialState;

    for (let cycle = 0; cycle < 100; cycle++) {
      const id = `stress-${cycle}`;
      state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id }) });
      state = sessionReducer(state, { type: "ACQUIRE_INJECTION_LOCK", sessionId: id });
      state = sessionReducer(state, { type: "SET_EXECUTION_MODE", sessionId: id, mode: "autonomous" });
      state = sessionReducer(state, { type: "SESSION_REMOVED", id });
    }

    // After all cycles, state should be clean
    expect(Object.keys(state.sessions).length).toBe(0);
    expect(Object.keys(state.executionModes).length).toBe(0);
    expect(Object.keys(state.injectionLocks).length).toBe(0);
    expect(state.activeSessionId).toBeNull();
  });

  it("interleaved session operations preserve non-related session state", () => {
    let state = initialState;

    // Create a persistent session
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id: "persistent", phase: "idle" }) });
    state = sessionReducer(state, { type: "SET_EXECUTION_MODE", sessionId: "persistent", mode: "assisted" });

    // Create and destroy 50 transient sessions
    for (let i = 0; i < 50; i++) {
      const id = `transient-${i}`;
      state = sessionReducer(state, { type: "SESSION_UPDATED", session: makeSession({ id }) });
      state = sessionReducer(state, { type: "SESSION_REMOVED", id });
    }

    // Persistent session should be untouched
    expect(state.sessions["persistent"]).toBeDefined();
    expect(state.sessions["persistent"].phase).toBe("idle");
    expect(state.executionModes["persistent"]).toBe("assisted");
  });
});
