// @vitest-environment jsdom
/**
 * Esc dismisses the suggestion overlay and its ghost text together. A ghost
 * left behind made the next Tab (meant for shell completion) run the
 * dismissed suggestion without Enter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	onData: new Map<string, (data: string) => void>(),
	writeToSession: vi.fn((_id: string, _b64: string) => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
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
const type = (data: string) => h.onData.get("current")!(data);
const written = () => h.writeToSession.mock.calls.map(([, b64]) => atob(b64));

beforeEach(async () => {
	h.writeToSession.mockClear();
	await createTerminal(S, "#fff");
});

afterEach(() => destroy(S));

describe("Esc on the suggestion overlay", () => {
	it("clears the ghost text, so the next Tab goes to the shell", () => {
		const entry = pool.get(S)!;
		entry.inputBuffer = "git pu";
		entry.suggestionState = {
			visible: true,
			suggestions: [{ text: "git push --force" } as never],
			selectedIndex: null,
			cursorX: 0,
			cursorY: 0,
			cellHeight: 16,
		};
		entry.ghostText = "sh --force";

		type("\x1b");
		expect(entry.ghostText).toBeNull();

		type("\t");
		expect(written()).toEqual(["\t"]);
	});
});
