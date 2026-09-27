import type { SessionAction } from "../types/session";
import { collectPanes, type LayoutNode, type SplitDirection } from "./layoutTypes";

/** Which session a pane showed before a new session was created. */
export interface PaneSnapshot {
	paneId: string;
	sessionId: string;
}

/** The focused pane and its session, read BEFORE creating a session. */
export function focusedPaneSnapshot(layout: { root: LayoutNode | null; focusedPaneId: string | null }): PaneSnapshot | null {
	if (!layout.root || !layout.focusedPaneId) return null;
	const pane = collectPanes(layout.root).find((p) => p.id === layout.focusedPaneId);
	return pane ? { paneId: pane.id, sessionId: pane.sessionId } : null;
}

/**
 * The actions that open a newly created session in a new pane next to
 * `split.paneId`.
 *
 * Creating a session makes it active, which puts it into whichever pane
 * was focused. That pane gets its own session back first, whether or not
 * it is the pane being split, or the new session would show twice.
 */
export function splitAfterCreateActions(
	focusedBefore: PaneSnapshot | null,
	split: { paneId: string; direction: SplitDirection },
	newSessionId: string,
): SessionAction[] {
	const actions: SessionAction[] = [];
	if (focusedBefore && focusedBefore.sessionId !== newSessionId) {
		actions.push({ type: "SET_PANE_SESSION", paneId: focusedBefore.paneId, sessionId: focusedBefore.sessionId });
	}
	actions.push({ type: "SPLIT_PANE", paneId: split.paneId, direction: split.direction, newSessionId });
	return actions;
}
