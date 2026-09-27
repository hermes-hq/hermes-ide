// @vitest-environment jsdom
/**
 * F03 — the terminal pool itself refuses to draw ghost text over a program
 * the shell started, and takes suggestions and ghost text down the moment
 * the OS reports such a program in the foreground.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	isShellForeground: vi.fn((_id: string) => Promise.resolve(true)),
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		buffer = { active: { type: "normal", cursorX: 0, cursorY: 0, viewportY: 0, baseY: 0, length: 0 } };
		rows = 24;
		options = {};
		loadAddon() {}
		attachCustomKeyEventHandler() {}
		onData() {}
		onScroll() {}
		getSelection() { return ""; }
		write() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/sessions", () => ({
	resizeSession: vi.fn(() => Promise.resolve()),
	isShellForeground: h.isShellForeground,
}));

import {
	pool,
	createTerminal,
	shellOwnsTerminal,
	showGhostText,
	refreshShellForeground,
	subscribeSuggestions,
	type PoolEntry,
} from "../terminal/pool";

const S = "s";

function addEntry(over: { shellIsForeground?: boolean; buffer?: "normal" | "alternate" } = {}): PoolEntry {
	const container = document.createElement("div");
	const screen = document.createElement("div");
	screen.className = "xterm-screen";
	container.appendChild(screen);
	document.body.appendChild(container);
	const entry = {
		terminal: {
			options: { fontSize: 14, fontFamily: "monospace", lineHeight: 1.2 },
			buffer: { active: { type: over.buffer ?? "normal", cursorX: 3, cursorY: 1 } },
		},
		container,
		attached: true,
		opened: true,
		ghostText: null,
		ghostOverlay: null,
		suggestionState: null,
		suggestionTimer: null,
		shellIsForeground: over.shellIsForeground ?? true,
	} as unknown as PoolEntry;
	pool.set(S, entry);
	return entry;
}

const ghostOnScreen = () => document.querySelectorAll(".ghost-text-overlay").length;

beforeEach(() => {
	pool.clear();
	document.body.innerHTML = "";
	h.isShellForeground.mockReset();
});

describe("showGhostText", () => {
	it("draws at a shell prompt", () => {
		const entry = addEntry();
		showGhostText(S, "atus");
		expect(ghostOnScreen()).toBe(1);
		expect(entry.ghostText).toBe("atus");
	});

	it("draws nothing while a program the shell started is in the foreground", () => {
		const entry = addEntry({ shellIsForeground: false });
		showGhostText(S, "atus");
		expect(ghostOnScreen()).toBe(0);
		expect(entry.ghostText).toBeNull();
	});

	it("draws nothing over a full-screen program", () => {
		addEntry({ buffer: "alternate" });
		showGhostText(S, "atus");
		expect(ghostOnScreen()).toBe(0);
	});
});

describe("refreshShellForeground", () => {
	it("takes down ghost text and suggestions when an agent takes the terminal", async () => {
		const entry = addEntry();
		showGhostText(S, "atus");
		entry.suggestionState = { visible: true, suggestions: [], selectedIndex: null, cursorX: 0, cursorY: 0, cellHeight: 16 };
		const seen: unknown[] = [];
		subscribeSuggestions(S, (state) => seen.push(state));

		h.isShellForeground.mockResolvedValueOnce(false);
		await expect(refreshShellForeground(S)).resolves.toBe(false);

		expect(entry.shellIsForeground).toBe(false);
		expect(ghostOnScreen()).toBe(0);
		expect(entry.ghostText).toBeNull();
		expect(entry.suggestionState).toBeNull();
		expect(seen.at(-1)).toBeNull();
	});

	it("leaves what is drawn alone while the shell keeps the terminal", async () => {
		const entry = addEntry();
		showGhostText(S, "atus");
		h.isShellForeground.mockResolvedValueOnce(true);
		await refreshShellForeground(S);
		expect(entry.shellIsForeground).toBe(true);
		expect(ghostOnScreen()).toBe(1);
	});

	it("records the shell coming back to the foreground", async () => {
		const entry = addEntry({ shellIsForeground: false });
		h.isShellForeground.mockResolvedValueOnce(true);
		await refreshShellForeground(S);
		expect(entry.shellIsForeground).toBe(true);
	});
});

describe("a new terminal", () => {
	it("draws nothing until the OS has said the shell owns it", async () => {
		await createTerminal(S, "#fff", () => {});
		const entry = pool.get(S)!;
		expect(entry.shellIsForeground).toBe(false);
		expect(shellOwnsTerminal(entry)).toBe(false);

		h.isShellForeground.mockResolvedValueOnce(true);
		await refreshShellForeground(S);
		expect(shellOwnsTerminal(entry)).toBe(true);
	});
});

describe("asking the OS", () => {
	it("asks once while a question for that session is still open", async () => {
		addEntry();
		let answer!: (fg: boolean) => void;
		h.isShellForeground.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));

		const poll = refreshShellForeground(S);
		const beforeSuggesting = refreshShellForeground(S);
		expect(h.isShellForeground).toHaveBeenCalledTimes(1);

		answer(false);
		await expect(poll).resolves.toBe(false);
		await expect(beforeSuggesting).resolves.toBe(false);
	});

	it("asks again once the last answer is in", async () => {
		addEntry();
		h.isShellForeground.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await expect(refreshShellForeground(S)).resolves.toBe(false);
		await expect(refreshShellForeground(S)).resolves.toBe(true);
		expect(h.isShellForeground).toHaveBeenCalledTimes(2);
	});

	it("asks again after a failed question", async () => {
		addEntry();
		h.isShellForeground.mockRejectedValueOnce(new Error("ipc")).mockResolvedValueOnce(true);
		await expect(refreshShellForeground(S)).rejects.toThrow("ipc");
		await expect(refreshShellForeground(S)).resolves.toBe(true);
	});
});
