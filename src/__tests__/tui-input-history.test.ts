/**
 * Issue #172 — keystrokes typed inside an interactive program (Claude, vim,
 * less, ...) must not be recorded as shell commands in suggestion history.
 *
 * Drives the real handleTerminalInput (captured via the mocked pool's
 * createTerminal) against a fake pool entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

function makeEntry(opts: { shellIsForeground: boolean; buffer: "normal" | "alternate" }) {
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
		terminal: { buffer: { active: { type: opts.buffer } } },
		historyProvider: { addCommand, match: () => [], loaded: true, markLoaded: () => {} },
	};
	h.pool.set("s1", entry);
	return { entry, addCommand };
}

function type(text: string) {
	for (const ch of text) h.handler!("s1", ch);
}

describe("Issue #172: input typed inside a TUI is not recorded as shell history", () => {
	beforeEach(async () => {
		h.pool.clear();
		await createTerminal("s1", "#fff");
	});

	it("records a line typed at the shell prompt", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "normal" });
		type("git status\r");
		expect(addCommand).toHaveBeenCalledWith("git status");
	});

	it("does not record input while another program owns the foreground (e.g. Claude inline)", () => {
		const { addCommand } = makeEntry({ shellIsForeground: false, buffer: "normal" });
		type("fix the login bug please\r");
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record input while the alternate screen is active (e.g. vim)", () => {
		const { addCommand } = makeEntry({ shellIsForeground: true, buffer: "alternate" });
		type(":wq\r");
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("does not record pasted multi-line input inside a TUI", () => {
		const { addCommand } = makeEntry({ shellIsForeground: false, buffer: "normal" });
		h.handler!("s1", "random words\rmore text\r");
		expect(addCommand).not.toHaveBeenCalled();
	});
});
