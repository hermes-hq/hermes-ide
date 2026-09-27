/**
 * #117 — the "shell_suggestions" setting turns Hermes's own inline
 * suggestions off ("native") or on (default, "hermes") for NEW sessions.
 *
 * Each session keeps the mode it was spawned with (the backend reports it as
 * `hermesSuggestions`), because the shell side — whether the shell's own
 * autosuggestion plugins were disabled — is fixed at spawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	writeToSession: vi.fn((..._args: unknown[]) => Promise.resolve()),
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
	dismissSuggestions: vi.fn(),
	dismissSuggestionsForEntry: vi.fn(),
	getFocusedSessionId: vi.fn(() => null),
	setCurrentSettings: vi.fn(),
}));

import { createTerminal, updateSettings } from "../terminal/TerminalPool";
import {
	detectShellEnvironment,
	clearShellEnvironment,
	getIntelligenceConfig,
	isIntelligenceDisabled,
	shouldShowGhostText,
	shouldShowOverlay,
	shouldConsumeTab,
} from "../terminal/intelligence/shellEnvironment";

/** What `detect_shell_environment` returns for a session (backend wire shape). */
function backendEnv(hermesSuggestions: boolean) {
	// Shell integration is active, so the "integration active → show ghost
	// text" fast path is exercised: it must not override the session's
	// spawn-time mode.
	return {
		shellType: "zsh",
		pluginsDetected: ["zsh-autosuggestions"],
		hasNativeAutosuggest: true,
		hasOhMyZsh: false,
		hasSyntaxHighlighting: false,
		hasStarship: false,
		hasPowerlevel10k: false,
		shellIntegrationActive: true,
		hermesSuggestions,
	};
}

async function spawnSession(sessionId: string, hermesSuggestions: boolean) {
	h.invoke.mockResolvedValueOnce(backendEnv(hermesSuggestions));
	await detectShellEnvironment(sessionId);
	expect(h.invoke).toHaveBeenLastCalledWith("detect_shell_environment", { sessionId });
}

describe("#117 shell_suggestions: per-session mode", () => {
	afterEach(() => {
		updateSettings({});
		for (const id of ["on", "off", "fresh"]) clearShellEnvironment(id);
		h.invoke.mockReset();
	});

	it("the backend's per-session flag drives ghost text, overlay and Tab", async () => {
		await spawnSession("on", true);
		await spawnSession("off", false);

		expect(shouldShowGhostText("on")).toBe(true);
		expect(shouldShowOverlay("on")).toBe(true);
		expect(shouldConsumeTab("on", true)).toBe(true);

		// Session spawned with Hermes suggestions off: shell integration is
		// active, but the shell's own autosuggestions were left on — Hermes
		// must not draw ghost text on top of them or steal Tab.
		expect(shouldShowGhostText("off")).toBe(false);
		expect(shouldShowOverlay("off")).toBe(false);
		expect(shouldConsumeTab("off", true)).toBe(false);
	});

	it("open sessions keep their mode when the setting changes", async () => {
		updateSettings({ shell_suggestions: "hermes" });
		await spawnSession("on", true);
		updateSettings({ shell_suggestions: "native" });
		await spawnSession("off", false);

		// Turn the setting back on: the session spawned while it was off stays off.
		updateSettings({ shell_suggestions: "hermes" });
		expect(shouldShowGhostText("off")).toBe(false);
		expect(shouldConsumeTab("off", true)).toBe(false);

		// Turn it off: the session spawned while it was on keeps Hermes suggestions.
		updateSettings({ shell_suggestions: "native" });
		expect(shouldShowGhostText("on")).toBe(true);
		expect(shouldShowOverlay("on")).toBe(true);
		expect(shouldConsumeTab("on", true)).toBe(true);
	});

	it("a session whose mode isn't reported yet follows the current setting", () => {
		updateSettings({ shell_suggestions: "native" });
		expect(shouldShowGhostText("fresh")).toBe(false);
		expect(shouldShowOverlay("fresh")).toBe(false);
		updateSettings({ shell_suggestions: "hermes" });
		expect(shouldShowGhostText("fresh")).toBe(true);
		expect(shouldShowOverlay("fresh")).toBe(true);
	});

	it("changing the setting leaves the rest of the intelligence config alone", () => {
		const before = { ...getIntelligenceConfig() };
		updateSettings({ shell_suggestions: "native" });
		expect(getIntelligenceConfig()).toEqual(before);
		expect(isIntelligenceDisabled()).toBe(false);
	});
});

describe("#117 shell_suggestions: ':' intent commands are not affected", () => {
	beforeEach(async () => {
		h.pool.clear();
		await createTerminal("s", "#fff");
	});

	afterEach(() => {
		h.pool.clear();
		updateSettings({});
		clearShellEnvironment("s");
		h.invoke.mockReset();
	});

	/** Type `line` then Enter in a session spawned with the given mode;
	 *  return what Enter wrote to the PTY. */
	async function enterWrites(hermesSuggestions: boolean, line: string): Promise<string[]> {
		updateSettings({ shell_suggestions: hermesSuggestions ? "hermes" : "native" });
		await spawnSession("s", hermesSuggestions);
		h.pool.set("s", {
			inputBuffer: "",
			ghostText: null,
			suggestionState: null,
			suggestionTimer: null,
			sessionPhase: "idle",
			lastStablePhase: "idle",
			cwd: "/tmp",
			shellIsForeground: true,
			terminal: { buffer: { active: { type: "normal" } } },
			historyProvider: { addCommand: vi.fn(), match: () => [], loaded: true, markLoaded: () => {} },
		});
		for (const ch of line) h.handler!("s", ch);
		h.writeToSession.mockClear();
		h.handler!("s", "\r");
		return h.writeToSession.mock.calls.map(([, payload]) =>
			new TextDecoder().decode(Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0))),
		);
	}

	it("keeps the intent-command gate open when Hermes suggestions are off", () => {
		// intelligenceActive in handleTerminalInput is derived from this.
		updateSettings({ shell_suggestions: "native" });
		expect(isIntelligenceDisabled()).toBe(false);
	});

	it("handles Enter on a ':' command the same with Hermes suggestions off as on", async () => {
		const on = await enterWrites(true, ":status");
		h.pool.clear();
		clearShellEnvironment("s");
		const off = await enterWrites(false, ":status");
		expect(off).toEqual(on);
	});
});
