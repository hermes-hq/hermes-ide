// @vitest-environment jsdom
/**
 * A restored session whose program already ended: its replayed output and
 * its exit both arrive while the terminal holds output. "[Session ended]"
 * must come after the replay, not above it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	listeners: new Map<string, (e: { payload: unknown }) => void>(),
	written: [] as string[],
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
		write(data: string | Uint8Array) {
			h.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
		}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
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
}));

import { createTerminal, destroy, releaseOutput } from "../terminal/pool";

const S = "s";

beforeEach(() => {
	h.written.length = 0;
});

afterEach(() => destroy(S));

describe("held output and session exit", () => {
	it("writes [Session ended] after the held replay", async () => {
		await createTerminal(S, "#fff", () => {}, { holdOutput: true });

		h.listeners.get(`pty-output-${S}`)!({ payload: btoa("old screen $ ") });
		h.listeners.get(`pty-exit-${S}`)!({ payload: null });
		releaseOutput(S, null);

		const all = h.written.join("");
		expect(all).toContain("old screen $ ");
		expect(all).toContain("[Session ended]");
		expect(all.indexOf("old screen $ ")).toBeLessThan(all.indexOf("[Session ended]"));
	});

	it("writes [Session ended] straight away when nothing is held", async () => {
		await createTerminal(S, "#fff", () => {});

		h.listeners.get(`pty-exit-${S}`)!({ payload: null });

		expect(h.written.join("")).toContain("[Session ended]");
	});
});
