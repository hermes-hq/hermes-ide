/**
 * Issue #172 — keystrokes typed inside an interactive program (Claude, vim,
 * less, ...) must not be recorded as shell commands in suggestion history.
 *
 * Drives the real handleTerminalInput (captured via the mocked pool's
 * createTerminal) against a fake pool entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../api/sessions", () => ({ writeToSession: vi.fn(() => Promise.resolve()) }));

const h = vi.hoisted(() => ({
	pool: new Map<string, unknown>(),
	handler: null as null | ((sessionId: string, data: string) => void),
}));

vi.mock("../terminal/pool", () => ({
	pool: h.pool,
	createTerminal: vi.fn((_id: string, _color: string, onInput: (sessionId: string, data: string) => void) => {
		h.handler = onInput;
		return Promise.resolve();
	}),
	clearGhostText: vi.fn(),
	dismissSuggestions: vi.fn(),
	dismissSuggestionsForEntry: vi.fn(),
	getFocusedSessionId: vi.fn(() => null),
}));

import { createTerminal } from "../terminal/TerminalPool";

/** The rows the screen shows once the echo has arrived; the cursor is on the last. */
type Row = { text: string; isWrapped?: boolean };

function fakeTerminal(type: "normal" | "alternate", rows: Row[]) {
	const normal = {
		getLine: (row: number) => {
			const r = rows[row];
			return r && { isWrapped: !!r.isWrapped, translateToString: () => r.text };
		},
	};
	return {
		buffer: { active: { type }, normal },
		registerMarker: () => ({ line: rows.length - 1, isDisposed: false, dispose: () => {} }),
	};
}

function makeEntry(opts: { shellIsForeground: boolean; buffer: "normal" | "alternate"; rows?: Row[] }) {
	const addCommand = vi.fn();
	const entry = {
		inputBuffer: "",
		ghostText: null,
		suggestionState: null,
		suggestionTimer: null,
		sessionPhase: "idle",
		lastStablePhase: "idle",
		cwd: "/tmp",
		shellIsForeground: opts.shellIsForeground,
		terminal: fakeTerminal(opts.buffer, opts.rows ?? [{ text: "$ git status" }]),
		historyProvider: { addCommand, match: () => [], loaded: true, markLoaded: () => {} },
	};
	h.pool.set("s1", entry);
	return { entry, addCommand };
}

function type(text: string) {
	for (const ch of text) h.handler!("s1", ch);
}

/** Enter is read back once the echo has settled. */
const settle = () => vi.advanceTimersByTime(1000);

beforeEach(async () => {
	vi.useFakeTimers();
	h.pool.clear();
	await createTerminal("s1", "#fff");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Issue #172: input typed inside a TUI is not recorded as shell history", () => {

	it("records a line typed at the shell prompt", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal" });
		type("git status\r");
		settle();
		expect(addCommand).toHaveBeenCalledWith("git status");
	});

	it("does not record input while another program owns the foreground (e.g. Claude inline)", () => {
		const { addCommand } = makeEntry({ shellIsForeground: false, buffer: "normal" });
		type("fix the login bug please\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record input while the alternate screen is active (e.g. vim)", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "alternate" });
		type(":wq\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record pasted multi-line input inside a TUI", () => {
		const { addCommand } = makeEntry({ shellIsForeground: false, buffer: "normal" });
		h.handler!("s1", "random words\rmore text\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});
});

describe("a line the terminal did not show is never remembered (password prompts)", () => {
	it("does not record a password typed at a prompt the shell itself shows (read -s)", () => {
		// The shell is in the foreground, but echo is off: nothing typed appears.
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal", rows: [{ text: "Password:" }] });
		type("hunter2\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record a password typed while the foreground check is a beat behind (sudo)", () => {
		// shellIsForeground still says true from before sudo started.
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal", rows: [{ text: "$ sudo ls" }, { text: "[sudo] password for me:" }] });
		type("correct horse battery staple\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record a password pasted together with Enter", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal", rows: [{ text: "Enter passphrase for key:" }] });
		h.handler!("s1", "s3cr3t-pass\r");
		settle();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("waits for the echo before deciding", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal" });
		type("git status\r");
		expect(addCommand).not.toHaveBeenCalled();
		settle();
		expect(addCommand).toHaveBeenCalledWith("git status");
	});

	it("records a long command that wraps across rows", () => {
		const { addCommand } = makeEntry({
			shellIsForeground: true,
			buffer: "normal",
			rows: [
				{ text: "$ git log --oneline --graph --decorate --all --sim" },
				{ text: "plify-by-decoration", isWrapped: true },
			],
		});
		type("git log --oneline --graph --decorate --all --simplify-by-decoration\r");
		settle();
		expect(addCommand).toHaveBeenCalledWith("git log --oneline --graph --decorate --all --simplify-by-decoration");
	});
});
