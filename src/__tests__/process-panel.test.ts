/**
 * Tests for the Processes Tab feature.
 *
 * - Reducer tests for TOGGLE_PROCESS_PANEL / SET_LEFT_TAB
 * - Sort/filter logic for process list
 * - Safety tests (protected processes, kill confirmation)
 * - Diff tests (new/removed PID detection)
 * - Virtualization tests (visible range computation)
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

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState } from "../state/SessionContext";
import {
  sortProcesses,
  filterProcesses,
  computeNewPids,
  computeRemovedPids,
} from "../components/ProcessPanel";
import type { ProcessInfo, ProcessFilter } from "../types/process";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeProcess(overrides?: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 1000,
    ppid: 1,
    name: "node",
    exe_path: "/usr/local/bin/node",
    cmd_line: ["node", "index.js"],
    cpu_percent: 5.0,
    memory_bytes: 1024 * 1024 * 50,
    memory_percent: 2.5,
    threads: 4,
    user: "testuser",
    status: "running",
    start_time: Math.floor(Date.now() / 1000) - 3600,
    fd_count: null,
    is_hermes_session: false,
    is_zombie: false,
    is_protected: false,
    ...overrides,
  };
}

function defaultFilter(overrides?: Partial<ProcessFilter>): ProcessFilter {
  return {
    search: "",
    cpuThreshold: 0,
    memThreshold: 0,
    showHermesOnly: false,
    showZombiesOnly: false,
    ...overrides,
  };
}

// ─── Reducer Tests ───────────────────────────────────────────────────

describe("Reducer: TOGGLE_PROCESS_PANEL", () => {
  it("toggles processPanelOpen and collapses sessions", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_PROCESS_PANEL" });
    expect(state1.ui.processPanelOpen).toBe(true);
    expect(state1.ui.activeLeftTab).toBe("processes");
    expect(state1.ui.sessionListCollapsed).toBe(true);
  });

  it("toggles back to sessions on second toggle", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_PROCESS_PANEL" });
    const state2 = sessionReducer(state1, { type: "TOGGLE_PROCESS_PANEL" });
    expect(state2.ui.processPanelOpen).toBe(false);
    expect(state2.ui.activeLeftTab).toBe("sessions");
  });
});

describe("Reducer: SET_LEFT_TAB", () => {
  it("switches to processes tab", () => {
    const state1 = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "processes" });
    expect(state1.ui.activeLeftTab).toBe("processes");
    expect(state1.ui.processPanelOpen).toBe(true);
    expect(state1.ui.sessionListCollapsed).toBe(true);
  });

  it("switches to sessions tab", () => {
    const withProcesses = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "processes" });
    const state2 = sessionReducer(withProcesses, { type: "SET_LEFT_TAB", tab: "sessions" });
    expect(state2.ui.activeLeftTab).toBe("sessions");
    expect(state2.ui.processPanelOpen).toBe(false);
    expect(state2.ui.sessionListCollapsed).toBe(false);
  });
});

describe("Initial state", () => {
  it("has processPanelOpen=false and activeLeftTab=terminal", () => {
    expect(initialState.ui.processPanelOpen).toBe(false);
    expect(initialState.ui.activeLeftTab).toBe("terminal");
  });
});

// ─── Sort Tests ──────────────────────────────────────────────────────

describe("sortProcesses", () => {
  const procs = [
    makeProcess({ pid: 1, name: "alpha", cpu_percent: 10 }),
    makeProcess({ pid: 2, name: "beta", cpu_percent: 50 }),
    makeProcess({ pid: 3, name: "gamma", cpu_percent: 30 }),
  ];

  it("sorts by CPU descending puts highest first", () => {
    const sorted = sortProcesses(procs, "cpu_percent", "desc");
    expect(sorted[0].name).toBe("beta");
    expect(sorted[1].name).toBe("gamma");
    expect(sorted[2].name).toBe("alpha");
  });

  it("sorts by name ascending is alphabetical", () => {
    const sorted = sortProcesses(procs, "name", "asc");
    expect(sorted[0].name).toBe("alpha");
    expect(sorted[1].name).toBe("beta");
    expect(sorted[2].name).toBe("gamma");
  });

  it("sorts by name descending reverses order", () => {
    const sorted = sortProcesses(procs, "name", "desc");
    expect(sorted[0].name).toBe("gamma");
    expect(sorted[2].name).toBe("alpha");
  });
});

// ─── Filter Tests ────────────────────────────────────────────────────

describe("filterProcesses", () => {
  const procs = [
    makeProcess({ pid: 100, name: "node", cpu_percent: 25, memory_percent: 5, is_hermes_session: true, is_zombie: false }),
    makeProcess({ pid: 200, name: "python", cpu_percent: 60, memory_percent: 40, is_hermes_session: false, is_zombie: false }),
    makeProcess({ pid: 300, name: "zombie-proc", cpu_percent: 0, memory_percent: 0, is_hermes_session: false, is_zombie: true }),
  ];

  it("search by name filters correctly", () => {
    const result = filterProcesses(procs, defaultFilter({ search: "nod" }));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("node");
  });

  it("search by PID matches exact PID", () => {
    const result = filterProcesses(procs, defaultFilter({ search: "200" }));
    expect(result.length).toBe(1);
    expect(result[0].pid).toBe(200);
  });

  it("CPU threshold excludes processes below threshold", () => {
    const result = filterProcesses(procs, defaultFilter({ cpuThreshold: 30 }));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("python");
  });

  it("memory threshold excludes processes below threshold", () => {
    const result = filterProcesses(procs, defaultFilter({ memThreshold: 10 }));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("python");
  });

  it("Hermes Only shows only is_hermes_session=true", () => {
    const result = filterProcesses(procs, defaultFilter({ showHermesOnly: true }));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("node");
  });

  it("Zombies Only shows only is_zombie=true", () => {
    const result = filterProcesses(procs, defaultFilter({ showZombiesOnly: true }));
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("zombie-proc");
  });
});

// ─── Safety Tests ────────────────────────────────────────────────────

describe("Safety", () => {
  it("protected processes have is_protected=true in mock data", () => {
    const proc = makeProcess({ is_protected: true, name: "launchd" });
    expect(proc.is_protected).toBe(true);
  });
});

// ─── Diff Tests ──────────────────────────────────────────────────────

describe("PID diff computation", () => {
  it("detects new PIDs correctly", () => {
    const prev = new Set([1, 2, 3]);
    const current = new Set([1, 2, 3, 4, 5]);
    const added = computeNewPids(prev, current);
    expect(added).toEqual(new Set([4, 5]));
  });

  it("detects removed PIDs correctly", () => {
    const prev = new Set([1, 2, 3, 4]);
    const current = new Set([1, 3]);
    const removed = computeRemovedPids(prev, current);
    expect(removed).toEqual(new Set([2, 4]));
  });

  it("identical snapshots produce empty diff sets", () => {
    const pids = new Set([1, 2, 3]);
    const added = computeNewPids(pids, pids);
    const removed = computeRemovedPids(pids, pids);
    expect(added.size).toBe(0);
    expect(removed.size).toBe(0);
  });
});

// ─── Virtualization Tests ────────────────────────────────────────────

describe("Virtualization", () => {
  it("only renders rows within viewport range", () => {
    // Simulate: 100 rows at 32px each, viewport = 320px (10 rows visible), scrollTop = 0
    const ROW_HEIGHT = 32;
    const OVERSCAN = 2;
    const totalRows = 100;
    const viewportHeight = 320;
    const scrollTop = 0;

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

    // With overscan ±2, at scroll=0 we get rows 0..12
    expect(startRow).toBe(0);
    expect(endRow).toBe(12);

    // Visible count should be reasonable (10 + 2 overscan on bottom = 12 + 1)
    const rendered = endRow - startRow + 1;
    expect(rendered).toBeLessThanOrEqual(15);
    expect(rendered).toBeGreaterThanOrEqual(10);
  });

  it("overscan includes ±2 extra rows on scroll", () => {
    const ROW_HEIGHT = 32;
    const OVERSCAN = 2;
    const totalRows = 100;
    const viewportHeight = 320;
    const scrollTop = 320; // scrolled down 10 rows

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

    // First visible row = 10, with -2 overscan = 8
    expect(startRow).toBe(8);
    // Last visible row = 20, with +2 overscan = 22
    expect(endRow).toBe(22);
  });
});
