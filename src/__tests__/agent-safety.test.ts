/**
 * F35 — one safety default across vendors.
 *
 * - every catalog agent maps the default to one of its own permission modes
 * - the launch line Hermes builds for that mode is never judged looser, and
 *   the "skip all permissions" modes always are (so the chip can fail)
 * - agents are recognised in agent command lines: Windows shims, multi-word
 *   commands, flags written as --flag=value; an agent's name as a later word
 *   is not an agent
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("2.0.0")) }));

import { AGENT_CATALOG, buildLaunchPreview, getAvailableModes, permissionFlagText } from "../catalog/agentCatalog";
import { findAgentInvocation, judgeSafety, safetyDefaultMode, safetyOf } from "../catalog/agentSafety";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import type { PermissionMode } from "../types/session";

const agents = AGENT_CATALOG.agents.filter((a) => !a.custom);

// The safety default is a 2.0 feature: it is on only with the agentCatalog flag.
beforeAll(async () => {
	await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: true }) });
});
afterAll(() => __resetFeatureFlagsForTest());

/** The argv Hermes's launch line produces for an agent in a mode (the line is typed unquoted). */
function launchArgs(agentId: string, mode: PermissionMode): string[] {
	const line = buildLaunchPreview(agentId, mode, "", "");
	const words = line.split(" ");
	const cmdWords = AGENT_CATALOG.agents.find((a) => a.id === agentId)!.terminal.argv.length;
	return words.slice(cmdWords);
}

describe("safety default: catalog mapping", () => {
	it.each(agents.map((a) => a.id))("%s maps the default to a permission mode it has", (id) => {
		const safety = safetyOf(id);
		expect(safety).toBeDefined();
		expect(getAvailableModes(id)).toContain(safety!.default_mode);
	});

	it("maps Claude, Codex, Gemini and Copilot exactly, each to its own flags", () => {
		expect(safetyDefaultMode("claude")).toBe("acceptEdits");
		expect(permissionFlagText("claude", "acceptEdits")).toBe("--permission-mode acceptEdits");
		expect(safetyDefaultMode("codex")).toBe("auto");
		expect(permissionFlagText("codex", "auto")).toBe("--sandbox workspace-write --ask-for-approval on-request");
		expect(permissionFlagText("gemini", safetyDefaultMode("gemini"))).toBe("--approval-mode auto_edit");
		expect(permissionFlagText("copilot", safetyDefaultMode("copilot"))).toBe("--allow-tool write");
		for (const id of ["claude", "codex", "gemini", "copilot"]) expect(safetyOf(id)!.fit).toBe("exact");
	});

	it("an unknown or custom agent starts in the plain default", () => {
		expect(safetyDefaultMode("custom")).toBe("default");
		expect(safetyDefaultMode("nope")).toBe("default");
		expect(safetyDefaultMode(null)).toBe("default");
	});

	it.each(agents.map((a) => a.id))("%s: the launch line for the mapped default is not looser", (id) => {
		const verdict = judgeSafety(id, launchArgs(id, safetyDefaultMode(id)));
		if (safetyOf(id)!.fit === "looser") {
			// No flag can hold it; the reason is the agent, not a flag Hermes passed.
			expect(verdict).toMatchObject({ level: "looser", reason: "vendor" });
		} else {
			expect(verdict).toEqual({ level: "ok" });
		}
	});

	it.each(agents.filter((a) => a.terminal.permission_flags.bypassPermissions).map((a) => a.id))(
		"%s: the skip-all-permissions mode is judged looser because of its flag",
		(id) => {
			const verdict = judgeSafety(id, launchArgs(id, "bypassPermissions"));
			expect(verdict).toMatchObject({ level: "looser", reason: "flag" });
		},
	);

	it("modes that auto-approve beyond edits are looser for every agent that has them", () => {
		for (const a of agents) {
			for (const mode of ["auto", "bypassPermissions"] as PermissionMode[]) {
				if (!a.terminal.permission_flags[mode] || mode === safetyDefaultMode(a.id)) continue;
				expect(judgeSafety(a.id, launchArgs(a.id, mode)).level, `${a.id} ${mode}`).toBe("looser");
			}
		}
	});
});

describe("safety default: reading a running agent's command line", () => {
	// The backend returns agent command lines starting at the agent's command
	// (wrappers are seen through there: src-tauri/src/agent_setup.rs).
	it("reads the agent and its flags from an agent command line", () => {
		const inv = findAgentInvocation([["/opt/tools/bin/claude", "--dangerously-skip-permissions"]]);
		expect(inv).toEqual({ agentId: "claude", args: ["--dangerously-skip-permissions"] });
		expect(judgeSafety(inv!.agentId, inv!.args)).toEqual({
			level: "looser",
			reason: "flag",
			flag: "--dangerously-skip-permissions",
		});
	});

	it("recognises Windows shims and paths", () => {
		expect(findAgentInvocation([["D:\\tools\\npm\\codex.cmd", "-s", "danger-full-access"]]))
			.toEqual({ agentId: "codex", args: ["-s", "danger-full-access"] });
		expect(judgeSafety("codex", ["-s", "danger-full-access"]).level).toBe("looser");
	});

	it("an agent's name as a later word is not an agent", () => {
		expect(findAgentInvocation([["cat", "claude"], ["git", "log", "--grep", "goose"], ["tail", "-f", "codex"]])).toBeNull();
	});

	it("skips a multi-word command's subcommand", () => {
		expect(findAgentInvocation([["kiro-cli", "chat", "--trust-all-tools"]])).toEqual({ agentId: "kiro", args: ["--trust-all-tools"] });
	});

	it("reads --flag=value forms", () => {
		expect(judgeSafety("claude", ["--permission-mode=bypassPermissions"]).level).toBe("looser");
		expect(judgeSafety("claude", ["--permission-mode=acceptEdits"]).level).toBe("ok");
		expect(judgeSafety("kiro", ["--trust-tools=fs_read,fs_write"]).level).toBe("looser");
	});

	it("does not flag a mode value that only looks similar", () => {
		// "auto" only counts after --permission-mode, not as a prompt word.
		expect(judgeSafety("claude", ["--model", "auto"]).level).toBe("ok");
		expect(judgeSafety("codex", ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]).level).toBe("ok");
	});

	it("prefers the session's own agent when several run", () => {
		const argvs = [["codex"], ["claude", "--permission-mode", "plan"]];
		expect(findAgentInvocation(argvs)?.agentId).toBe("codex");
		expect(findAgentInvocation(argvs, "claude")?.agentId).toBe("claude");
	});

	it("finds nothing in a plain shell", () => {
		expect(findAgentInvocation([])).toBeNull();
		expect(findAgentInvocation([["-zsh"], ["vim", "notes.md"]])).toBeNull();
	});

	it("an agent with no flag for the default is looser even without flags", () => {
		expect(judgeSafety("opencode", [])).toMatchObject({ level: "looser", reason: "vendor" });
		expect(judgeSafety("goose", [])).toMatchObject({ level: "looser", reason: "vendor" });
	});
});
