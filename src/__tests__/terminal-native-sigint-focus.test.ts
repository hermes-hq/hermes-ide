// @vitest-environment jsdom
/**
 * macOS Ctrl+C arrives as the "native-sigint" menu event. It must reach the
 * terminal that holds keyboard focus, not whichever terminal was attached
 * last (split panes), and no terminal at all while focus is somewhere else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	listeners: new Map<string, (e: { payload: unknown }) => void>(),
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
		onData() {}
		onScroll() {}
		getSelection() { return ""; }
		hasSelection() { return false; }
		write() {}
		open() {}
		focus() {}
		refresh() {}
		scrollToBottom() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
		h.listeners.set(name, cb);
		return Promise.resolve(() => {});
	}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/sessions", () => ({
	resizeSession: vi.fn(() => Promise.resolve()),
	isShellForeground: vi.fn(() => Promise.resolve(true)),
	writeToSession: h.writeToSession,
}));

import { createTerminal, attach, destroy } from "../terminal/TerminalPool";
import { pool } from "../terminal/pool";

const SIGINT = btoa("\x03");

function viewport(): HTMLDivElement {
	const vp = document.createElement("div");
	document.body.appendChild(vp);
	return vp;
}

/** Stand-in for xterm's hidden textarea, which takes keyboard focus. */
function focusInside(sessionId: string): void {
	const container = pool.get(sessionId)!.container;
	const textarea = document.createElement("textarea");
	container.appendChild(textarea);
	textarea.focus();
}

function sigint(): void {
	h.listeners.get("native-sigint")!({ payload: null });
}

function sigintTargets(): string[] {
	return h.writeToSession.mock.calls.filter(([, b64]) => b64 === SIGINT).map(([id]) => id);
}

beforeEach(async () => {
	document.body.innerHTML = "";
	h.writeToSession.mockClear();
	await createTerminal("A", "#fff");
	await createTerminal("B", "#fff");
	attach("A", viewport(), false);
	attach("B", viewport(), false); // B is attached last
});

afterEach(() => {
	destroy("A");
	destroy("B");
});

describe("native-sigint (macOS Ctrl+C)", () => {
	it("goes to the focused pane, not the one attached last", () => {
		focusInside("A");
		sigint();
		expect(sigintTargets()).toEqual(["A"]);
	});

	it("goes nowhere while focus is in an input outside any terminal", () => {
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		sigint();
		expect(sigintTargets()).toEqual([]);
	});

	it("still reaches the focused pane after the last-attached pane is destroyed", () => {
		destroy("B");
		focusInside("A");
		sigint();
		expect(sigintTargets()).toEqual(["A"]);
	});
});
