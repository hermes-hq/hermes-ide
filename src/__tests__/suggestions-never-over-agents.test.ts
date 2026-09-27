/**
 * F03 — Hermes never draws suggestions or ghost text over a program the
 * shell started (an agent CLI's own input box), and never types a command
 * into the terminal on its own.
 *
 * Drives the real input handler (TerminalPool) against a fake pool entry.
 * The pool's foreground check is mocked: `cached` is what the last poll saw,
 * `os` is what the OS says right now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	writeToSession: vi.fn((..._args: unknown[]) => Promise.resolve()),
	notifySubscribers: vi.fn(),
	showGhostText: vi.fn(),
	refreshShellForeground: vi.fn((_id: string): Promise<boolean> => Promise.resolve(true)),
	pool: new Map<string, unknown>(),
	handler: null as null | ((sessionId: string, data: string) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../api/sessions", () => ({ writeToSession: h.writeToSession }));
vi.mock("../terminal/pool", () => ({
	pool: h.pool,
	createTerminal: vi.fn((_id: string, _color: string, onInput: (sessionId: string, data: string) => void) => {
		h.handler = onInput;
		return Promise.resolve();
	}),
	clearGhostText: vi.fn(),
	showGhostText: h.showGhostText,
	dismissSuggestions: vi.fn((id: string) => {
		const e = h.pool.get(id) as { suggestionState: unknown } | undefined;
		if (e) e.suggestionState = null;
	}),
	dismissSuggestionsForEntry: vi.fn((e: { suggestionState: unknown }) => {
		e.suggestionState = null;
	}),
	notifySubscribers: h.notifySubscribers,
	getCursorPixelPosition: vi.fn(() => ({ x: 0, y: 0, cellHeight: 16 })),
	getFocusedSessionId: vi.fn(() => null),
	setCurrentSettings: vi.fn(),
	refreshShellForeground: h.refreshShellForeground,
}));

import { createTerminal, updateSettings } from "../terminal/TerminalPool";
import { detectShellEnvironment, clearShellEnvironment } from "../terminal/intelligence/shellEnvironment";

const S = "s";

interface FakeEntry {
	inputBuffer: string;
	ghostText: string | null;
	suggestionState: { visible: boolean; suggestions: { text: string }[]; selectedIndex: number | null } | null;
	suggestionTimer: ReturnType<typeof setTimeout> | null;
	sessionPhase: string;
	lastStablePhase: string;
	cwd: string;
	shellIsForeground: boolean;
	userScrolledUp: boolean;
	terminal: { buffer: { active: { type: string } } };
	historyProvider: { addCommand: ReturnType<typeof vi.fn>; match: () => never[]; loaded: boolean; markLoaded: () => void };
}

/** A session with Hermes inline suggestions on, sitting at a shell prompt. */
async function spawn(over: Partial<FakeEntry> = {}): Promise<FakeEntry> {
	updateSettings({ shell_suggestions: "hermes" });
	h.invoke.mockResolvedValueOnce({
		shellType: "zsh",
		pluginsDetected: [],
		hasNativeAutosuggest: false,
		hasOhMyZsh: false,
		hasSyntaxHighlighting: false,
		hasStarship: false,
		hasPowerlevel10k: false,
		shellIntegrationActive: true,
		hermesSuggestions: true,
	});
	await detectShellEnvironment(S);
	const entry: FakeEntry = {
		inputBuffer: "",
		ghostText: null,
		suggestionState: null,
		suggestionTimer: null,
		sessionPhase: "idle",
		lastStablePhase: "idle",
		cwd: "/tmp",
		shellIsForeground: true,
		userScrolledUp: false,
		terminal: { buffer: { active: { type: "normal" } } },
		historyProvider: { addCommand: vi.fn(), match: () => [], loaded: true, markLoaded: () => {} },
		...over,
	};
	h.pool.set(S, entry);
	return entry;
}

/** What the OS says when asked who owns the terminal right now. */
function osSays(foreground: boolean | Error): void {
	h.refreshShellForeground.mockImplementation((id: string) => {
		if (foreground instanceof Error) return Promise.reject(foreground);
		const e = h.pool.get(id) as FakeEntry | undefined;
		if (e) e.shellIsForeground = foreground;
		return Promise.resolve(foreground);
	});
}

function type(keys: string): void {
	for (const k of keys) h.handler!(S, k);
}

/** Decoded payloads written to the PTY. */
function written(): string {
	return h.writeToSession.mock.calls
		.map(([, payload]) => new TextDecoder().decode(Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0))))
		.join("");
}

function drewSomething(): boolean {
	const shown = h.notifySubscribers.mock.calls.some(([, state]) => (state as { visible?: boolean } | null)?.visible);
	return shown || h.showGhostText.mock.calls.length > 0;
}

beforeEach(async () => {
	vi.useFakeTimers();
	h.pool.clear();
	await createTerminal(S, "#fff");
	h.writeToSession.mockClear();
	h.notifySubscribers.mockClear();
	h.showGhostText.mockClear();
	h.refreshShellForeground.mockClear();
	osSays(true);
});

afterEach(() => {
	vi.useRealTimers();
	h.pool.clear();
	updateSettings({});
	clearShellEnvironment(S);
	h.invoke.mockReset();
});

describe("at a plain shell prompt", () => {
	it("suggestions and ghost text are shown (the setting is on)", async () => {
		const entry = await spawn();
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(entry.suggestionState?.visible).toBe(true);
		expect(entry.suggestionState?.suggestions.map((s) => s.text)).toContain("git status");
		expect(entry.suggestionState?.selectedIndex).toBeNull();
		expect(h.showGhostText).toHaveBeenCalled();
		expect(h.showGhostText.mock.calls[0][1]).toMatch(/^atus/);
	});
});

describe("with an agent CLI (or any program) in the foreground", () => {
	it("draws nothing when the last poll saw the program", async () => {
		const entry = await spawn({ shellIsForeground: false });
		osSays(false);
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(drewSomething()).toBe(false);
		expect(entry.suggestionState).toBeNull();
	});

	it("draws nothing when the program started after the last poll", async () => {
		// The cached value still says "shell", the OS already says otherwise.
		const entry = await spawn({ shellIsForeground: true });
		osSays(false);
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.refreshShellForeground).toHaveBeenCalledWith(S);
		expect(drewSomething()).toBe(false);
		expect(entry.suggestionState).toBeNull();
	});

	it("draws nothing when the foreground cannot be checked", async () => {
		await spawn();
		osSays(new Error("session gone"));
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(drewSomething()).toBe(false);
	});

	it("draws nothing while an agent waits for input", async () => {
		await spawn({ sessionPhase: "needs_input", lastStablePhase: "needs_input" });
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(drewSomething()).toBe(false);
	});

	it("draws nothing over a full-screen program", async () => {
		await spawn({ terminal: { buffer: { active: { type: "alternate" } } } });
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(drewSomething()).toBe(false);
	});
});

describe("a check that finishes after more typing", () => {
	it("is dropped; the newer input gets its own suggestions", async () => {
		const entry = await spawn();
		let release!: (fg: boolean) => void;
		h.refreshShellForeground.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }));
		type("git s");
		await vi.advanceTimersByTimeAsync(60); // first check is now pending
		type("t");
		release(true); // answers for "git s", but the prompt reads "git st"
		await vi.advanceTimersByTimeAsync(100);
		const drawnFor = h.notifySubscribers.mock.calls
			.map(([, state]) => state as { suggestions: { text: string }[] } | null)
			.filter(Boolean);
		expect(drawnFor).toHaveLength(1);
		expect(entry.suggestionState?.visible).toBe(true);
	});
});

describe("Hermes never types on its own", () => {
	it("only the user's own keys reach the terminal, whatever is suggested", async () => {
		await spawn();
		type("git st");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(written()).toBe("git st");
	});
});
