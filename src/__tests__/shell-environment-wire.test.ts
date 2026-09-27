/**
 * `detect_shell_environment` reaches the frontend with camelCase fields
 * (the Rust side asserts the same names in
 * `shell_environment_serializes_every_field_camel_case`).
 *
 * The backend used to send snake_case, so every field except
 * `hermesSuggestions` read as undefined: shell-history loading never knew the
 * shell, and the shell-integration / native-autosuggest checks below never
 * ran. These tests pin what those now-live checks do.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
	applyShellSuggestionsSetting,
	clearShellEnvironment,
	detectShellEnvironment,
	getShellEnvironment,
	shouldConsumeTab,
	shouldShowGhostText,
	shouldShowOverlay,
} from "../terminal/intelligence/shellEnvironment";
import { createHistoryProvider, loadHistory } from "../terminal/intelligence/historyProvider";

const S = "s";

/** Exactly what the Rust `ShellEnvironment` serializes to. */
function wire(over: Record<string, unknown> = {}) {
	return {
		shellType: "zsh",
		pluginsDetected: ["oh-my-zsh", "zsh-autosuggestions"],
		hasNativeAutosuggest: true,
		hasOhMyZsh: true,
		hasSyntaxHighlighting: false,
		hasStarship: false,
		hasPowerlevel10k: false,
		shellIntegrationActive: true,
		hermesSuggestions: true,
		...over,
	};
}

async function detect(over: Record<string, unknown> = {}) {
	h.invoke.mockResolvedValueOnce(wire(over));
	return detectShellEnvironment(S);
}

afterEach(() => {
	clearShellEnvironment(S);
	applyShellSuggestionsSetting({});
	h.invoke.mockReset();
});

describe("shell environment reaches the frontend", () => {
	it("every field the frontend reads is defined", async () => {
		const env = await detect();
		expect(env).toEqual(getShellEnvironment(S));
		expect(env.shellType).toBe("zsh");
		expect(env.pluginsDetected).toEqual(["oh-my-zsh", "zsh-autosuggestions"]);
		expect(env.hasNativeAutosuggest).toBe(true);
		expect(env.hasOhMyZsh).toBe(true);
		expect(env.shellIntegrationActive).toBe(true);
		expect(env.hermesSuggestions).toBe(true);
	});

	it("shell history is loaded for the detected shell", async () => {
		const env = await detect();
		const provider = createHistoryProvider();
		h.invoke.mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "read_shell_history" ? ["git status", "npm test"] : []),
		);
		await loadHistory(provider, S, env.shellType);
		expect(h.invoke).toHaveBeenCalledWith("read_shell_history", { shell: "zsh", limit: expect.any(Number) });
		expect(provider.match("git st").map((m) => m.command)).toEqual(["git status"]);
	});
});

describe("typical zsh user with shell integration (zsh-autosuggestions installed)", () => {
	it("Hermes suggestions on: Hermes ghost text + Tab (the plugin was disabled at spawn)", async () => {
		await detect();
		expect(shouldShowGhostText(S)).toBe(true);
		expect(shouldShowOverlay(S)).toBe(true);
		expect(shouldConsumeTab(S, true)).toBe(true);
		// Tab is never taken when the list isn't showing.
		expect(shouldConsumeTab(S, false)).toBe(false);
	});

	it("Hermes suggestions off: the shell's own suggestions and Tab, no Hermes ghost text", async () => {
		await detect({ hermesSuggestions: false });
		expect(shouldShowGhostText(S)).toBe(false);
		expect(shouldShowOverlay(S)).toBe(false);
		expect(shouldConsumeTab(S, true)).toBe(false);
	});
});

describe("no shell integration (a local shell Hermes can't hook)", () => {
	it("zsh with zsh-autosuggestions left running: no Hermes ghost text, Tab goes to the shell", async () => {
		await detect({ shellIntegrationActive: false });
		expect(shouldShowGhostText(S)).toBe(false);
		expect(shouldConsumeTab(S, true)).toBe(false);
		// The list itself can still be used with the arrow keys and Enter.
		expect(shouldShowOverlay(S)).toBe(true);
	});

	it("zsh without an autosuggest plugin: Hermes ghost text and Tab", async () => {
		await detect({
			shellIntegrationActive: false,
			hasNativeAutosuggest: false,
			pluginsDetected: [],
		});
		expect(shouldShowGhostText(S)).toBe(true);
		expect(shouldConsumeTab(S, true)).toBe(true);
	});

	it("fish (built-in autosuggestions): defers to the shell", async () => {
		await detect({ shellType: "fish", shellIntegrationActive: false, pluginsDetected: [] });
		expect(shouldShowGhostText(S)).toBe(false);
		expect(shouldConsumeTab(S, true)).toBe(false);
	});

	it("PowerShell (PSReadLine predictions): defers to the shell", async () => {
		await detect({
			shellType: "powershell",
			shellIntegrationActive: false,
			pluginsDetected: ["PSReadLine"],
		});
		expect(shouldShowGhostText(S)).toBe(false);
		expect(shouldConsumeTab(S, true)).toBe(false);
	});
});

describe("fish with shell integration", () => {
	it("Hermes suggestions on: fish's own autosuggestions were turned off, Hermes shows its own", async () => {
		await detect({ shellType: "fish", pluginsDetected: [] });
		expect(shouldShowGhostText(S)).toBe(true);
		expect(shouldConsumeTab(S, true)).toBe(true);
	});
});

/** What the backend sends for an SSH session: the local shell's config and
 *  history belong to a different machine, so none of it is reported. */
const REMOTE = {
	shellType: "remote",
	pluginsDetected: [],
	hasNativeAutosuggest: false,
	hasOhMyZsh: false,
	hasSyntaxHighlighting: false,
	hasStarship: false,
	hasPowerlevel10k: false,
	shellIntegrationActive: false,
};

describe("SSH session (remote shell)", () => {
	it("local zsh-autosuggestions doesn't suppress Hermes ghost text or Tab on the remote", async () => {
		await detect(REMOTE);
		expect(shouldShowGhostText(S)).toBe(true);
		expect(shouldShowOverlay(S)).toBe(true);
		expect(shouldConsumeTab(S, true)).toBe(true);
	});

	it("Hermes suggestions off still applies over SSH", async () => {
		await detect({ ...REMOTE, hermesSuggestions: false });
		expect(shouldShowGhostText(S)).toBe(false);
		expect(shouldShowOverlay(S)).toBe(false);
		expect(shouldConsumeTab(S, true)).toBe(false);
	});

	it("local shell history is not loaded; this session's own commands still are", async () => {
		const env = await detect(REMOTE);
		const provider = createHistoryProvider();
		h.invoke.mockImplementation((cmd: string) =>
			Promise.resolve(
				cmd === "read_shell_history" ? ["local-only-cmd"] : cmd === "get_session_commands" ? ["uptime"] : [],
			),
		);
		await loadHistory(provider, S, env.shellType);
		expect(h.invoke).not.toHaveBeenCalledWith("read_shell_history", expect.anything());
		expect(provider.match("local").map((m) => m.command)).toEqual([]);
		expect(provider.match("upt").map((m) => m.command)).toEqual(["uptime"]);
		expect(provider.loaded).toBe(true);
	});
});
