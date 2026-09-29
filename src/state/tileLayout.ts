// ─── "Tile working agents" (F24) ──────────────────────────────────────
//
// One command lays the sessions whose agent is working (or waiting on you
// mid-task) out as a grid of split panes, so a fleet can be watched at a
// glance. It is an ordinary split layout: every pane stays a normal pane
// the person can close, resize or swap.

import type { AgentStatusKind } from "../agent/contract/status";
import {
  nextPaneId,
  nextSplitId,
  type LayoutNode,
  type PaneLeaf,
} from "./layoutTypes";

/** More panes than this are too small to read; the rest stay in the list. */
export const TILE_MAX_PANES = 9;

/**
 * Statuses that count as "working": doing something, or stopped in the
 * middle of a task until a person answers.
 */
export const WORKING_STATUS_KINDS: ReadonlySet<AgentStatusKind> = new Set<AgentStatusKind>([
  "working",
  "needs_approval",
  "needs_answer",
  "plan_ready",
  "gate",
]);

export interface TileCandidate {
  readonly id: string;
  readonly phase: string;
  readonly ai_provider: string | null;
}

/**
 * The sessions to tile, in the order given (the sidebar's): those whose
 * reported status is a working one, plus agent sessions the terminal
 * already sees busy.
 */
export function workingSessionIds(
  sessions: readonly TileCandidate[],
  statusOf: (sessionId: string) => AgentStatusKind,
): string[] {
  return sessions
    .filter((s) => s.phase !== "destroyed")
    .filter((s) => WORKING_STATUS_KINDS.has(statusOf(s.id)) || (s.ai_provider !== null && s.phase === "busy"))
    .map((s) => s.id);
}

function pane(sessionId: string): PaneLeaf {
  return { type: "pane", id: nextPaneId(), sessionId };
}

/** Equal parts along one direction, as a chain of binary splits. */
function chain(nodes: LayoutNode[], direction: "horizontal" | "vertical"): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  return {
    type: "split",
    id: nextSplitId(),
    direction,
    children: [nodes[0], chain(nodes.slice(1), direction)],
    ratio: 1 / nodes.length,
  };
}

/** How many panes each row gets: as square as possible, fuller rows first. */
export function gridRows(count: number): number[] {
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * A grid of panes for these sessions (at most TILE_MAX_PANES), or null for
 * none. Rows of side-by-side panes, stacked top to bottom.
 */
export function tileLayout(sessionIds: readonly string[]): LayoutNode | null {
  const ids = [...new Set(sessionIds)].slice(0, TILE_MAX_PANES);
  if (ids.length === 0) return null;
  const rows: LayoutNode[] = [];
  let start = 0;
  for (const n of gridRows(ids.length)) {
    rows.push(chain(ids.slice(start, start + n).map(pane), "horizontal"));
    start += n;
  }
  return chain(rows, "vertical");
}
