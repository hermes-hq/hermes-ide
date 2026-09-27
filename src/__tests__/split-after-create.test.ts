/**
 * Splitting a pane opens the new session next to it. Creating the session
 * makes it active, which swaps it into the focused pane first; the split
 * must give that pane its own session back so no session shows twice.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));

import { initialState, sessionReducer } from "../state/SessionContext";
import { collectPanes, type LayoutNode } from "../state/layoutTypes";
import { focusedPaneSnapshot, splitAfterCreateActions } from "../state/splitAfterCreate";
import type { SessionState } from "../types/session";

/** Two panes side by side: p1 shows s1, p2 shows s2. */
function twoPanes(focusedPaneId: string): SessionState {
	const root: LayoutNode = {
		type: "split",
		id: "split-1",
		direction: "horizontal",
		ratio: 0.5,
		children: [
			{ type: "pane", id: "p1", sessionId: "s1" },
			{ type: "pane", id: "p2", sessionId: "s2" },
		],
	};
	return { ...initialState, activeSessionId: focusedPaneId === "p1" ? "s1" : "s2", layout: { root, focusedPaneId } };
}

/** What the app does: snapshot, create (which activates), then split. */
function splitWithNewSession(state: SessionState, targetPaneId: string): SessionState {
	const before = focusedPaneSnapshot(state.layout);
	let next = sessionReducer(state, { type: "SET_ACTIVE", id: "s3" });
	for (const action of splitAfterCreateActions(before, { paneId: targetPaneId, direction: "horizontal" }, "s3")) {
		next = sessionReducer(next, action);
	}
	return next;
}

const shown = (state: SessionState) => collectPanes(state.layout.root!).map((p) => `${p.id}:${p.sessionId}`);

describe("split with a new session", () => {
	it("splitting the focused pane keeps its session and adds the new one beside it", () => {
		const after = splitWithNewSession(twoPanes("p1"), "p1");
		const panes = collectPanes(after.layout.root!);
		expect(panes.map((p) => p.sessionId)).toEqual(["s1", "s3", "s2"]);
		expect(after.activeSessionId).toBe("s3");
		expect(after.layout.focusedPaneId).toBe(panes[1].id);
	});

	it("splitting a pane that is not focused leaves the focused pane's session alone", () => {
		const after = splitWithNewSession(twoPanes("p2"), "p1");
		const sessions = collectPanes(after.layout.root!).map((p) => p.sessionId);
		expect(sessions).toEqual(["s1", "s3", "s2"]);
		expect(sessions.filter((s) => s === "s3")).toHaveLength(1);
		expect(shown(after)).toContain("p2:s2");
	});

	it("with no focused pane there is nothing to restore", () => {
		const state = twoPanes("p1");
		expect(focusedPaneSnapshot({ ...state.layout, focusedPaneId: null })).toBeNull();
		expect(splitAfterCreateActions(null, { paneId: "p1", direction: "vertical" }, "s3")).toEqual([
			{ type: "SPLIT_PANE", paneId: "p1", direction: "vertical", newSessionId: "s3" },
		]);
	});
});
