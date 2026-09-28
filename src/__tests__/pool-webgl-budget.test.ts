// @vitest-environment jsdom
/**
 * F24 — graphics contexts go to the terminals on screen. With the fleetPerf
 * flag on, hiding a terminal (detach) gives its WebGL context back and
 * showing it again takes a fresh one; with the flag off a terminal keeps
 * its context for life (the old behaviour). A lost context is dropped, and
 * a web view without WebGL is not asked again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	flagOn: true,
	webglThrows: false,
	created: 0,
	disposed: 0,
	lossHandlers: [] as (() => void)[],
	/** Contexts the fake addon drew with, and how many were freed. */
	contexts: [] as { lost: boolean }[],
}));

vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		disposedHere = false;
		constructor() {
			if (h.webglThrows) throw new Error("WebGL2 not supported");
			h.created++;
		}
		onContextLoss(cb: () => void) {
			h.lossHandlers.push(cb);
		}
		dispose() {
			if (this.disposedHere) return;
			this.disposedHere = true;
			h.disposed++;
		}
	},
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/sessions", () => ({
	resizeSession: vi.fn(() => Promise.resolve()),
	isShellForeground: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: (id: string) => id === "fleetPerf" && h.flagOn }));

import { pool, attach, detach, webglSessionIds, isWebglAvailable, type PoolEntry } from "../terminal/pool";

/** What loading the real addon does to the page: a canvas with a WebGL2
 *  context on the terminal's screen (asking the canvas again hands back the
 *  same context). */
function drawsWithWebgl(container: HTMLElement) {
	return vi.fn(() => {
		const gl = {
			lost: false,
			getExtension: (name: string) =>
				name === "WEBGL_lose_context" ? { loseContext: () => { gl.lost = true; } } : null,
		};
		h.contexts.push(gl);
		const canvas = document.createElement("canvas");
		canvas.getContext = ((type: string) => (type === "webgl2" ? gl : null)) as never;
		container.appendChild(canvas);
	});
}

function addEntry(id: string): PoolEntry {
	const container = document.createElement("div");
	const entry = {
		terminal: {
			open: vi.fn(),
			loadAddon: drawsWithWebgl(container),
			focus: vi.fn(),
			refresh: vi.fn(),
			scrollToBottom: vi.fn(),
			rows: 24,
			cols: 80,
		},
		fitAddon: { proposeDimensions: () => ({ cols: 80, rows: 24 }), fit: vi.fn() },
		container,
		attached: false,
		opened: false,
		viewport: null,
		ghostText: null,
		ghostOverlay: null,
		userScrolledUp: false,
		suggestionState: null,
		suggestionTimer: null,
		shellIsForeground: true,
		shellFgPollTimer: null,
		cwd: "",
		webgl: null,
	} as unknown as PoolEntry;
	pool.set(id, entry);
	return entry;
}

const viewport = () => document.createElement("div");

beforeEach(() => {
	for (const e of pool.values()) if (e.shellFgPollTimer) clearInterval(e.shellFgPollTimer);
	pool.clear();
	h.flagOn = true;
	h.created = 0;
	h.disposed = 0;
	h.lossHandlers = [];
	h.contexts = [];
	h.webglThrows = false;
});

describe("with fleetPerf on, only terminals on screen hold a context", () => {
	it("gives the context back on detach and takes a new one on attach", () => {
		const a = addEntry("a");
		const b = addEntry("b");
		const pane = viewport();
		attach("a", pane, false);
		expect(webglSessionIds()).toEqual(["a"]);
		expect(a.terminal.loadAddon).toHaveBeenCalledTimes(1);

		// Switching the pane to b hides a: one context, and it is b's.
		attach("b", pane, false);
		expect(a.attached).toBe(false);
		expect(webglSessionIds()).toEqual(["b"]);
		expect(h.disposed).toBe(1);

		// Back to a: it takes a context again at once.
		attach("a", pane, false);
		expect(webglSessionIds()).toEqual(["a"]);
		expect(a.terminal.loadAddon).toHaveBeenCalledTimes(2);
		expect(h.created).toBe(3);
		expect(h.disposed).toBe(2);
		expect(b.webgl).toBeNull();
	});

	it("frees a hidden terminal's graphics memory at once, not at the next garbage collection", () => {
		addEntry("a");
		addEntry("b");
		const pane = viewport();
		attach("a", pane, false);
		expect(h.contexts.map((c) => c.lost)).toEqual([false]);
		attach("b", pane, false);
		expect(h.contexts.map((c) => c.lost)).toEqual([true, false]);
		attach("a", pane, false);
		expect(h.contexts.map((c) => c.lost)).toEqual([true, true, false]);
	});

	it("twenty terminals shown one after another never hold more than the visible one", () => {
		const pane = viewport();
		for (let i = 0; i < 20; i++) addEntry(`s${i}`);
		for (let i = 0; i < 20; i++) {
			attach(`s${i}`, pane, false);
			expect(webglSessionIds()).toEqual([`s${i}`]);
		}
		// Four panes on screen: four contexts.
		const panes = [viewport(), viewport(), viewport(), viewport()];
		for (let i = 0; i < 4; i++) attach(`s${i}`, panes[i], false);
		detach("s19");
		expect(webglSessionIds().sort()).toEqual(["s0", "s1", "s2", "s3"]);
	});

	it("drops a context the web view took away, and gets one again next time", () => {
		addEntry("a");
		attach("a", viewport(), false);
		h.lossHandlers[0]();
		expect(webglSessionIds()).toEqual([]);
		detach("a");
		attach("a", viewport(), false);
		expect(webglSessionIds()).toEqual(["a"]);
	});
});

describe("with fleetPerf off (negative control: the old behaviour)", () => {
	it("every terminal ever shown keeps its context", () => {
		h.flagOn = false;
		const pane = viewport();
		for (let i = 0; i < 5; i++) {
			addEntry(`s${i}`);
			attach(`s${i}`, pane, false);
		}
		expect(webglSessionIds().length).toBe(5);
		expect(h.disposed).toBe(0);
		expect(h.contexts.some((c) => c.lost)).toBe(false);
	});

	it("one terminal failing to get WebGL does not stop the next one from trying", () => {
		h.flagOn = false;
		h.webglThrows = true;
		addEntry("a");
		attach("a", viewport(), false);
		h.webglThrows = false;
		addEntry("b");
		attach("b", viewport(), false);
		expect(webglSessionIds()).toEqual(["b"]);
	});
});

describe("a web view without WebGL", () => {
	it("is asked once; terminals keep working without it", () => {
		h.webglThrows = true;
		const a = addEntry("a");
		attach("a", viewport(), false);
		expect(a.webgl).toBeNull();
		expect(a.opened).toBe(true);
		expect(isWebglAvailable()).toBe(false);
		h.webglThrows = false;
		addEntry("b");
		attach("b", viewport(), false);
		expect(webglSessionIds()).toEqual([]);
	});
});
