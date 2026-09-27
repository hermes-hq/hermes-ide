/**
 * ':' intent commands — keystrokes in, PTY bytes out.
 *
 * Typing a ':' command (e.g. `:status`) at the shell prompt and pressing
 * Enter must erase it and run the command it stands for (`git status`).
 * Picking an intent from the ':' list must do the same — never type the raw
 * `:status` into the shell. Both must work with Hermes inline suggestions on
 * or off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	writeToSession: vi.fn((..._args: unknown[]) => Promise.resolve()),
	notifySubscribers: vi.fn(),
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
	showGhostText: vi.fn(),
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
	// The OS agrees with the cached foreground value.
	refreshShellForeground: vi.fn((id: string) =>
		Promise.resolve((h.pool.get(id) as { shellIsForeground: boolean }).shellIsForeground),
	),
}));

import { createTerminal, updateSettings } from "../terminal/TerminalPool";
import { detectShellEnvironment, clearShellEnvironment } from "../terminal/intelligence/shellEnvironment";

const S = "s";

interface FakeEntry {
	inputBuffer: string;
	ghostText: string | null;
	suggestionState: { visible: boolean; suggestions: { text: string; badge?: string }[]; selectedIndex: number | null } | null;
	suggestionTimer: ReturnType<typeof setTimeout> | null;
	sessionPhase: string;
	lastStablePhase: string;
	cwd: string;
	shellIsForeground: boolean;
	userScrolledUp: boolean;
	terminal: { buffer: { active: { type: string } } };
	historyProvider: { addCommand: ReturnType<typeof vi.fn>; match: () => never[]; loaded: boolean; markLoaded: () => void };
}

function makeEntry(over: Partial<FakeEntry> = {}): FakeEntry {
	return {
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
}

/** Start a session spawned with Hermes inline suggestions on/off. */
async function spawn(hermesSuggestions: boolean, over: Partial<FakeEntry> = {}): Promise<FakeEntry> {
	updateSettings({ shell_suggestions: hermesSuggestions ? "hermes" : "native" });
	h.invoke.mockResolvedValueOnce({
		shellType: "zsh",
		pluginsDetected: ["zsh-autosuggestions"],
		hasNativeAutosuggest: true,
		hasOhMyZsh: false,
		hasSyntaxHighlighting: false,
		hasStarship: false,
		hasPowerlevel10k: false,
		shellIntegrationActive: true,
		hermesSuggestions,
	});
	await detectShellEnvironment(S);
	const entry = makeEntry(over);
	h.pool.set(S, entry);
	return entry;
}

function type(keys: string | string[]): void {
	for (const k of typeof keys === "string" ? [...keys] : keys) h.handler!(S, k);
}

/** Decoded payloads written to the PTY since the last clear. */
function written(): string[] {
	return h.writeToSession.mock.calls.map(([, payload]) =>
		new TextDecoder().decode(Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0))),
	);
}

const DEL = "\x7f";
const DOWN = "\x1b[B";

beforeEach(async () => {
	vi.useFakeTimers();
	h.pool.clear();
	await createTerminal(S, "#fff");
	h.writeToSession.mockClear();
	h.notifySubscribers.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	h.pool.clear();
	updateSettings({});
	clearShellEnvironment(S);
	h.invoke.mockReset();
});

describe("Enter on a typed ':' command", () => {
	for (const hermesSuggestions of [true, false]) {
		describe(`Hermes suggestions ${hermesSuggestions ? "on" : "off"}`, () => {
			it(":status + Enter erases the typed text and runs git status", async () => {
				const entry = await spawn(hermesSuggestions);
				type(":status");
				h.writeToSession.mockClear();
				type("\r");
				expect(written()).toEqual([DEL.repeat(7) + "git status\r"]);
				expect(entry.inputBuffer).toBe("");
				expect(entry.historyProvider.addCommand).toHaveBeenCalledWith("git status");
			});

			it("works while the prompt still reads busy from the keystroke echo", async () => {
				// Every echoed keystroke flips sessionPhase to "busy" until the
				// output has been quiet for a while — Enter comes well before that.
				const entry = await spawn(hermesSuggestions);
				type(":log");
				entry.sessionPhase = "busy";
				h.writeToSession.mockClear();
				type("\r");
				expect(written()).toEqual([DEL.repeat(4) + "git log --oneline -15\r"]);
			});
		});
	}

	it("an edited line resolves what is actually on the prompt", async () => {
		await spawn(true);
		type([...":stx", DEL]); // ":st" (a short alias of :status)
		h.writeToSession.mockClear();
		type("\r");
		expect(written()).toEqual([DEL.repeat(3) + "git status\r"]);
	});

	it("an unknown ':' command is passed to the shell unchanged", async () => {
		const entry = await spawn(true);
		type(":nope");
		h.writeToSession.mockClear();
		type("\r");
		expect(written()).toEqual(["\r"]);
		expect(entry.inputBuffer).toBe("");
	});

	it("is left alone when a program, not the shell, is in the foreground", async () => {
		await spawn(true, { shellIsForeground: false });
		type(":status");
		h.writeToSession.mockClear();
		type("\r");
		expect(written()).toEqual(["\r"]);
	});

	it("is left alone in a full-screen program (alternate screen)", async () => {
		const entry = await spawn(true);
		type(":status");
		entry.terminal.buffer.active.type = "alternate";
		h.writeToSession.mockClear();
		type("\r");
		expect(written()).toEqual(["\r"]);
	});

	it("is left alone while an AI agent is waiting for input", async () => {
		await spawn(true, { sessionPhase: "needs_input", lastStablePhase: "needs_input" });
		type(":status");
		h.writeToSession.mockClear();
		type("\r");
		expect(written()).toEqual(["\r"]);
	});
});

describe("the ':' list", () => {
	for (const hermesSuggestions of [true, false]) {
		describe(`Hermes suggestions ${hermesSuggestions ? "on" : "off"}`, () => {
			it("appears when ':' is typed", async () => {
				const entry = await spawn(hermesSuggestions);
				type(":sta");
				await vi.advanceTimersByTimeAsync(100);
				expect(entry.suggestionState?.visible).toBe(true);
				expect(entry.suggestionState?.suggestions.map((s) => s.text)).toContain(":status");
				expect(h.notifySubscribers).toHaveBeenLastCalledWith(S, entry.suggestionState);
			});

			it("Enter on a highlighted intent runs its command, not the raw ':' text", async () => {
				const entry = await spawn(hermesSuggestions);
				type(":sta");
				await vi.advanceTimersByTimeAsync(100);
				expect(entry.suggestionState?.suggestions[0].text).toBe(":status");
				type([DOWN]);
				h.writeToSession.mockClear();
				type("\r");
				expect(written()).toEqual([DEL.repeat(4) + "git status\r"]);
				expect(entry.inputBuffer).toBe("");
				expect(entry.historyProvider.addCommand).toHaveBeenCalledWith("git status");
				expect(entry.historyProvider.addCommand).not.toHaveBeenCalledWith(":status");
			});

			it("Tab on a highlighted intent completes it; Enter then runs it", async () => {
				const entry = await spawn(hermesSuggestions);
				type(":sta");
				await vi.advanceTimersByTimeAsync(100);
				type([DOWN]);
				h.writeToSession.mockClear();
				type("\t");
				expect(written()).toEqual([DEL.repeat(4) + ":status"]);
				expect(entry.inputBuffer).toBe(":status");
				h.writeToSession.mockClear();
				type("\r");
				expect(written()).toEqual([DEL.repeat(7) + "git status\r"]);
			});
		});
	}

	it("ordinary (non-':') suggestions stay off when Hermes suggestions are off", async () => {
		const entry = await spawn(false);
		entry.historyProvider.match = () => [];
		type("git st");
		await vi.advanceTimersByTimeAsync(100);
		expect(entry.suggestionState).toBeNull();
		expect(h.notifySubscribers).not.toHaveBeenCalled();
	});
});
