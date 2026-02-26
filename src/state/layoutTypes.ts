// ─── Split-Pane Layout Types ─────────────────────────────────────────

export type SplitDirection = "horizontal" | "vertical";

export interface PaneLeaf {
  type: "pane";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: [LayoutNode, LayoutNode];
  ratio: number; // 0.0–1.0, first child's share
}

export type LayoutNode = PaneLeaf | SplitNode;

// ─── ID Generator ────────────────────────────────────────────────────

let paneCounter = 0;

export function nextPaneId(): string {
  return `pane-${++paneCounter}`;
}

let splitCounter = 0;

export function nextSplitId(): string {
  return `split-${++splitCounter}`;
}

// ─── Tree Helpers (pure, immutable) ──────────────────────────────────

/** Replace a node in the tree by its ID, returning a new tree. */
export function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (root.type === "pane") return root;
  return {
    ...root,
    children: [
      replaceNode(root.children[0], targetId, replacement),
      replaceNode(root.children[1], targetId, replacement),
    ],
  };
}

/** Remove a pane from the tree, promoting its sibling. Returns null if last pane. */
export function removePane(
  root: LayoutNode,
  paneId: string,
): LayoutNode | null {
  if (root.type === "pane") {
    return root.id === paneId ? null : root;
  }

  const [left, right] = root.children;

  // Direct child is the pane to remove — promote sibling
  if (left.type === "pane" && left.id === paneId) return right;
  if (right.type === "pane" && right.id === paneId) return left;

  // Recurse into children
  const newLeft = removePane(left, paneId);
  const newRight = removePane(right, paneId);

  // If a child was removed entirely, promote the other
  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;

  // If nothing changed, return as-is
  if (newLeft === left && newRight === right) return root;

  return {
    ...root,
    children: [newLeft, newRight],
  };
}

/** Collect all PaneLeaf nodes in visual order (left-to-right, top-to-bottom). */
export function collectPanes(root: LayoutNode): PaneLeaf[] {
  if (root.type === "pane") return [root];
  return [
    ...collectPanes(root.children[0]),
    ...collectPanes(root.children[1]),
  ];
}

/** Find a pane displaying a specific session. */
export function findPaneBySession(
  root: LayoutNode,
  sessionId: string,
): PaneLeaf | null {
  if (root.type === "pane") {
    return root.sessionId === sessionId ? root : null;
  }
  return (
    findPaneBySession(root.children[0], sessionId) ||
    findPaneBySession(root.children[1], sessionId)
  );
}

/** Find a node by ID. */
export function findNodeById(
  root: LayoutNode,
  id: string,
): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === "pane") return null;
  return (
    findNodeById(root.children[0], id) ||
    findNodeById(root.children[1], id)
  );
}

/** Update the ratio on a split node. */
export function updateSplitRatio(
  root: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode {
  if (!Number.isFinite(ratio)) return root; // Guard against NaN/Infinity
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  if (root.type === "pane") return root;
  if (root.id === splitId) {
    return { ...root, ratio: clamped };
  }
  const newLeft = updateSplitRatio(root.children[0], splitId, ratio);
  const newRight = updateSplitRatio(root.children[1], splitId, ratio);
  if (newLeft === root.children[0] && newRight === root.children[1]) return root;
  return { ...root, children: [newLeft, newRight] };
}

/** Update the sessionId on a pane. */
export function setPaneSession(
  root: LayoutNode,
  paneId: string,
  sessionId: string,
): LayoutNode {
  if (root.type === "pane") {
    return root.id === paneId ? { ...root, sessionId } : root;
  }
  const newLeft = setPaneSession(root.children[0], paneId, sessionId);
  const newRight = setPaneSession(root.children[1], paneId, sessionId);
  if (newLeft === root.children[0] && newRight === root.children[1]) return root;
  return { ...root, children: [newLeft, newRight] };
}

/** Remove all panes displaying a given session from the tree. */
export function removePanesBySession(
  root: LayoutNode,
  sessionId: string,
): LayoutNode | null {
  const panes = collectPanes(root).filter((p) => p.sessionId === sessionId);
  let current: LayoutNode | null = root;
  for (const pane of panes) {
    if (!current) break;
    current = removePane(current, pane.id);
  }
  return current;
}
