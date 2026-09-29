/**
 * F24 — "Tile working agents": which sessions count as working, the grid
 * they are laid out in, and the reducer action that applies it.
 */
import { describe, it, expect } from "vitest";
import { gridRows, tileLayout, TILE_MAX_PANES, workingSessionIds } from "../state/tileLayout";
import { collectPanes, type LayoutNode } from "../state/layoutTypes";
import { initialState, sessionReducer } from "../state/SessionContext";
import type { SessionData } from "../types/session";
import type { AgentStatusKind } from "../agent/contract/status";

/** Row sizes of a tiled layout, read back from the tree. */
function rowsOf(root: LayoutNode): number[] {
  const rows: LayoutNode[] = [];
  let node: LayoutNode = root;
  while (node.type === "split" && node.direction === "vertical") {
    rows.push(node.children[0]);
    node = node.children[1];
  }
  rows.push(node);
  return rows.map((r) => collectPanes(r).length);
}

describe("gridRows / tileLayout", () => {
  it("lays panes out as square as possible, fuller rows first", () => {
    expect(gridRows(0)).toEqual([]);
    expect(gridRows(1)).toEqual([1]);
    expect(gridRows(2)).toEqual([2]);
    expect(gridRows(3)).toEqual([2, 1]);
    expect(gridRows(4)).toEqual([2, 2]);
    expect(gridRows(5)).toEqual([3, 2]);
    expect(gridRows(7)).toEqual([3, 2, 2]);
    expect(gridRows(9)).toEqual([3, 3, 3]);
  });

  it("builds one pane per session in order, rows of equal-width panes", () => {
    const root = tileLayout(["a", "b", "c", "d", "e"])!;
    expect(collectPanes(root).map((p) => p.sessionId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rowsOf(root)).toEqual([3, 2]);
    // First row: a | (b | c) with a taking a third, b half of the rest.
    const firstRow = (root as Extract<LayoutNode, { type: "split" }>).children[0];
    expect(firstRow.type === "split" && firstRow.direction).toBe("horizontal");
    expect(firstRow.type === "split" && firstRow.ratio).toBeCloseTo(1 / 3);
    expect(root.type === "split" && root.ratio).toBeCloseTo(1 / 2);
    const ids = new Set(collectPanes(root).map((p) => p.id));
    expect(ids.size).toBe(5);
  });

  it("caps the grid, drops duplicates, and has nothing to tile for none", () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(collectPanes(tileLayout(many)!).length).toBe(TILE_MAX_PANES);
    expect(collectPanes(tileLayout(["a", "a", "b"])!).map((p) => p.sessionId)).toEqual(["a", "b"]);
    expect(tileLayout([])).toBeNull();
  });
});

describe("workingSessionIds", () => {
  const sessions = [
    { id: "idle-agent", phase: "idle", ai_provider: "claude" },
    { id: "working", phase: "idle", ai_provider: null },
    { id: "approval", phase: "idle", ai_provider: "codex" },
    { id: "busy-agent", phase: "busy", ai_provider: "claude" },
    { id: "busy-shell", phase: "busy", ai_provider: null },
    { id: "done", phase: "idle", ai_provider: "claude" },
    { id: "gone", phase: "destroyed", ai_provider: "claude" },
  ];
  const status: Record<string, AgentStatusKind> = {
    working: "working",
    approval: "needs_approval",
    done: "done_unread",
    gone: "working",
  };

  it("takes reported working or waiting-mid-task agents, and agents the terminal sees busy", () => {
    expect(workingSessionIds(sessions, (id) => status[id] ?? "idle")).toEqual(["working", "approval", "busy-agent"]);
  });
});

describe("TILE_SESSIONS", () => {
  const session = (id: string) => ({ id, label: id, phase: "idle" }) as unknown as SessionData;
  const withSessions = {
    ...initialState,
    sessions: { a: session("a"), b: session("b"), c: session("c") },
  };

  it("replaces the layout with the grid and focuses its first pane", () => {
    const next = sessionReducer(withSessions, { type: "TILE_SESSIONS", sessionIds: ["b", "c", "zzz-closed"] });
    const panes = collectPanes(next.layout.root!);
    expect(panes.map((p) => p.sessionId)).toEqual(["b", "c"]);
    expect(next.layout.focusedPaneId).toBe(panes[0].id);
    expect(next.activeSessionId).toBe("b");
  });

  it("changes nothing when no session is left to tile", () => {
    expect(sessionReducer(withSessions, { type: "TILE_SESSIONS", sessionIds: ["zzz"] })).toBe(withSessions);
  });
});
