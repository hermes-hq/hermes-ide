// @vitest-environment jsdom
/**
 * Changing the font size or family refits xterm to a new column/row count.
 * The PTY must hear about it, or the shell keeps formatting for the old width.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	resizeSession: vi.fn((_id: string, _rows: number, _cols: number) => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/sessions", () => ({
	resizeSession: h.resizeSession,
	isShellForeground: vi.fn(() => Promise.resolve(true)),
	writeToSession: vi.fn(() => Promise.resolve()),
}));

import { updateSettings } from "../terminal/TerminalPool";
import { pool, type PoolEntry } from "../terminal/pool";

beforeEach(() => {
	pool.clear();
	h.resizeSession.mockClear();
});

describe("updateSettings", () => {
	it("tells the PTY the new size after a font change refits the terminal", () => {
		const terminal = { options: {}, rows: 40, cols: 160, refresh: vi.fn() };
		const fitAddon = {
			proposeDimensions: () => ({ cols: 124, rows: 31 }),
			// fit() resizes xterm to the proposed dimensions.
			fit: () => { terminal.cols = 124; terminal.rows = 31; },
		};
		pool.set("s", {
			terminal,
			fitAddon,
			container: document.createElement("div"),
			attached: true,
			opened: true,
			ghostText: null,
			ghostOverlay: null,
		} as unknown as PoolEntry);

		updateSettings({ font_size: "18" });

		expect(h.resizeSession).toHaveBeenCalledWith("s", 31, 124);
	});
});
