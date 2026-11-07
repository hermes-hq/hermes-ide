// @vitest-environment jsdom
/**
 * ↑ in a plain terminal is the shell's history, as in any terminal. The
 * suggestion list only keeps ↑ once ↓ has moved into it, and after ↑/↓ have
 * changed the prompt line Hermes no longer suggests for the text typed before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	onData: new Map<string, (data: string) => void>(),
	writeToSession: vi.fn((_id: string, _b64: string) => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		unicode = { activeVersion: "6" };
		buffer = { active: { type: "normal", cursorX: 0, cursorY: 0, viewportY: 0, baseY: 0, length: 0 } };
		rows = 24;
		cols = 80;
		options: Record<string, unknown> = {};
		loadAddon() {}
		attachCustomKeyEventHandler() {}
		onData(cb: (data: string) => void) { h.onData.set("current", cb); }
		onScroll() {}
		getSelection() { return ""; }
		hasSelection() { return false; }
		write() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/sessions", () => ({
	resizeSession: vi.fn(() => Promise.resolve()),
	isShellForeground: vi.fn(() => Promise.resolve(true)),
	writeToSession: h.writeToSession,
}));

import { createTerminal, destroy } from "../terminal/TerminalPool";
import { pool } from "../terminal/pool";

const S = "s";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const type = (data: string) => h.onData.get("current")!(data);
const written = () => h.writeToSession.mock.calls.map(([, b64]) => atob(b64));

function openList(entry: NonNullable<ReturnType<typeof pool.get>>, typed: string) {
	entry.inputBuffer = typed;
	entry.suggestionState = {
		visible: true,
		suggestions: [{ text: "git push" } as never, { text: "git pull" } as never],
		selectedIndex: null,
		cursorX: 0,
		cursorY: 0,
		cellHeight: 16,
	};
}

beforeEach(async () => {
	h.writeToSession.mockClear();
	await createTerminal(S, "#fff");
	pool.get(S)!.shellIsForeground = true;
});

afterEach(() => destroy(S));

describe("↑ with the suggestion list open", () => {
	it("goes to the shell and closes the list when nothing is highlighted", () => {
		const entry = pool.get(S)!;
		openList(entry, "git p");
		type(UP);
		expect(written()).toEqual([UP]);
		expect(entry.suggestionState?.visible ?? false).toBe(false);
	});

	it("moves inside the list once ↓ has moved into it", () => {
		const entry = pool.get(S)!;
		openList(entry, "git p");
		type(DOWN);
		expect(entry.suggestionState?.selectedIndex).toBe(0);
		type(UP);
		expect(entry.suggestionState?.selectedIndex).toBe(1);
		expect(written()).toEqual([]);
	});
});

describe("↑ at the shell's prompt", () => {
	it("forgets the typed text: no suggestions and no history entry until the line is new", () => {
		vi.useFakeTimers();
		try {
			const entry = pool.get(S)!;
			entry.inputBuffer = "git p";
			type(UP);
			expect(written()).toEqual([UP]);
			expect(entry.inputBuffer).toBe("");
			expect(entry.lineFromShell).toBe(true);
			// Editing the recalled line does not bring a list back.
			type("x");
			vi.advanceTimersByTime(2000);
			expect(entry.suggestionState?.visible ?? false).toBe(false);
			// Enter starts a new line; Hermes suggests again after it.
			type("\r");
			expect(entry.lineFromShell).toBe(false);
			expect(entry.inputBuffer).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves ↑ alone for a program the shell started", () => {
		const entry = pool.get(S)!;
		entry.shellIsForeground = false;
		entry.inputBuffer = "/mo";
		type(UP);
		expect(written()).toEqual([UP]);
		expect(entry.inputBuffer).toBe("/mo");
		expect(entry.lineFromShell).toBe(false);
	});
});
