/**
 * F06 — agent catalog as data.
 *
 * - src/catalog/agents.json validates against src/catalog/agents.schema.json
 *   (and the schema rejects broken entries: negative controls below)
 * - rules the schema cannot express: unique ids, one Custom agent, no retired
 *   install command, Antigravity is the main Google entry
 * - the helpers the UI uses behave: which agents a build shows (flag), launch
 *   line (same table as the Rust side), modes, names, install hints
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Ajv from "ajv";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	getVersion: vi.fn(() => Promise.resolve("2.0.0")),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));

import catalog from "../catalog/agents.json";
import schema from "../catalog/agents.schema.json";
import launchCases from "../catalog/launch-cases.json";
import {
	AGENT_CATALOG,
	agentDisplayName,
	buildLaunchPreview,
	customAgent,
	getAgent,
	getAvailableModes,
	installCommand,
	launchFailedMessage,
	listAgents,
	permissionFlagText,
	type AgentEntry,
} from "../catalog/agentCatalog";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import type { PermissionMode } from "../types/session";
import { checkAiProviders } from "../api/sessions";

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, strictTuples: false, allowUnionTypes: true });
const validate = ajv.compile(schema);

type Json = Record<string, unknown>;
const clone = (): { version: number; agents: Json[] } => JSON.parse(JSON.stringify(catalog));
const byId = (c: { agents: Json[] }, id: string) => c.agents.find((a) => a.id === id) as Json & { terminal: Json; install: Json };

function schemaErrors(data: unknown): string {
	return validate(data) ? "" : ajv.errorsText(validate.errors, { separator: "\n" });
}

describe("agent catalog: schema", () => {
	it("the shipped catalog validates", () => {
		expect(schemaErrors(catalog)).toBe("");
	});

	// Negative controls: each mutation must be rejected, or the schema proves nothing.
	const broken: Array<[string, (c: { agents: Json[] }) => void]> = [
		["an agent without an install command", (c) => { byId(c, "codex").install = null; }],
		["an argv item a shell would split", (c) => { byId(c, "codex").terminal.argv = ["codex; rm -rf ~"]; }],
		["a detect binary with a space", (c) => { (byId(c, "claude").detect as Json).command = ["my claude", "--version"]; }],
		["an unknown permission mode", (c) => { (byId(c, "claude").terminal.permission_flags as Json).yolo = ["--yolo"]; }],
		["a default mode that adds flags", (c) => { (byId(c, "claude").terminal.permission_flags as Json).default = ["--x"]; }],
		["a legacy entry without a note", (c) => { delete byId(c, "gemini").status_note; }],
		["an unknown field", (c) => { byId(c, "aider").launch = "aider"; }],
		["a signals plan with events but method none", (c) => { byId(c, "aider").terminal.signals = { method: "none", confidence: "guessed", events: { turn_end: ["x"] } }; }],
		["a missing resume block", (c) => { delete byId(c, "claude").terminal.resume; }],
		["an unknown placeholder", (c) => { byId(c, "claude").terminal.new_session_id = ["--session-id", "{uuid}"]; }],
		["a Custom agent with a command", (c) => { byId(c, "custom").terminal.argv = ["sh"]; }],
		["an http install page", (c) => { byId(c, "kiro").install.url = "http://kiro.dev"; }],
		["an unknown structured protocol", (c) => { byId(c, "codex").structured = { protocol: "grpc" }; }],
	];
	for (const [what, mutate] of broken) {
		it(`rejects ${what}`, () => {
			const c = clone();
			mutate(c);
			expect(schemaErrors(c)).not.toBe("");
		});
	}
});

describe("agent catalog: content rules", () => {
	const agents = AGENT_CATALOG.agents;

	it("has unique ids and exactly one Custom agent", () => {
		const ids = agents.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(agents.filter((a) => a.custom).map((a) => a.id)).toEqual(["custom"]);
	});

	it("lists every agent the plan names, plus the ones Hermes already had", () => {
		expect(agents.map((a) => a.id)).toEqual([
			"claude", "codex", "antigravity", "gemini", "copilot", "opencode", "goose", "hermes-agent", "aider", "kiro", "custom",
		]);
	});

	it("keeps every agent Hermes 1.x offered on the stable channel", () => {
		for (const id of ["claude", "gemini", "aider", "codex", "copilot", "kiro"]) {
			expect(getAgent(id)?.channel, id).toBe("stable");
		}
	});

	it("has no retired or deprecated install command", () => {
		const retired = [
			/gh extension install github\/gh-copilot/, // the gh extension Copilot CLI replaced
			/npm install -g kiro-cli/, // not how Kiro CLI is installed
			/npm install -g @anthropic-ai\/claude-code/, // the native installer is the documented default
			/^pip install aider-chat$/, // aider-install is the documented default
		];
		for (const a of agents) {
			for (const cmd of [a.install?.command, a.install?.windows].filter(Boolean) as string[]) {
				for (const r of retired) expect(cmd, `${a.id}: ${cmd}`).not.toMatch(r);
			}
		}
		expect(getAgent("claude")?.install?.command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
		expect(getAgent("copilot")?.install?.command).toBe("npm install -g @github/copilot");
	});

	it("never launches the retired gh copilot extension", () => {
		expect(getAgent("copilot")?.terminal.argv).toEqual(["copilot"]);
		expect(getAgent("copilot")?.detect?.command[0]).toBe("copilot");
	});

	it("makes Antigravity the main Google entry and keeps Gemini CLI as legacy with the retirement noted", () => {
		const ids = agents.map((a) => a.id);
		expect(ids.indexOf("antigravity")).toBeLessThan(ids.indexOf("gemini"));
		const gemini = getAgent("gemini")!;
		expect(gemini.status).toBe("legacy");
		expect(gemini.status_note).toMatch(/Retired for personal Google accounts on 2026-06-18/);
		expect(getAgent("antigravity")?.status).toBe("current");
	});

	it("gives every agent with a command a detect command for the same binary", () => {
		for (const a of agents.filter((x) => !x.custom)) {
			expect(a.detect?.command[0], a.id).toBe(a.terminal.argv[0]);
		}
	});

	it("does not pass the Codex flag that 0.145 removed", () => {
		const flags = Object.values(getAgent("codex")!.terminal.permission_flags).flat();
		expect(flags).not.toContain("--full-auto");
	});
});

describe("agent catalog: launch line", () => {
	it("builds every shared case exactly like the Rust side", () => {
		expect(launchCases.cases.length).toBeGreaterThanOrEqual(10);
		for (const c of launchCases.cases) {
			const got = buildLaunchPreview(c.agent, c.mode as PermissionMode, c.prefix, c.suffix, c.command);
			expect(got, JSON.stringify(c)).toBe(c.expected ?? "");
		}
	});

	it("lists modes in a fixed order and only the ones the agent supports", () => {
		expect(getAvailableModes("claude")).toEqual(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
		expect(getAvailableModes("codex")).toEqual(["default", "auto", "bypassPermissions"]);
		expect(getAvailableModes("custom")).toEqual(["default"]);
		expect(getAvailableModes("nope")).toEqual(["default"]);
		expect(permissionFlagText("gemini", "acceptEdits")).toBe("--approval-mode auto_edit");
		expect(permissionFlagText("gemini", "dontAsk")).toBe("");
	});
});

describe("agent catalog: what a build shows", () => {
	beforeEach(() => __resetFeatureFlagsForTest());

	const ids = (list: AgentEntry[]) => list.map((a) => a.id);

	it("stable without the flag: the 1.x agents only, no Custom agent", async () => {
		await initFeatureFlags({});
		expect(ids(listAgents())).toEqual(["claude", "codex", "gemini", "copilot", "aider", "kiro"]);
		expect(customAgent()).toBeUndefined();
	});

	it("with the agentCatalog flag forced on: every agent and the Custom agent", async () => {
		await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: true }) });
		expect(ids(listAgents())).toEqual(["claude", "codex", "antigravity", "gemini", "copilot", "opencode", "goose", "hermes-agent", "aider", "kiro"]);
		expect(customAgent()?.id).toBe("custom");
	});

	it("asks the backend to look for the beta agents only when the flag shows them", async () => {
		h.invoke.mockResolvedValue({});
		await initFeatureFlags({});
		await checkAiProviders();
		expect(h.invoke).toHaveBeenLastCalledWith("check_ai_providers", { includeBeta: false });
		__resetFeatureFlagsForTest();
		await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: true }) });
		await checkAiProviders();
		expect(h.invoke).toHaveBeenLastCalledWith("check_ai_providers", { includeBeta: true });
	});

	it("beta channel shows them without an override; a forced-off override hides them", async () => {
		await initFeatureFlags({ update_channel: "beta" });
		expect(listAgents()).toHaveLength(10);
		__resetFeatureFlagsForTest();
		await initFeatureFlags({ update_channel: "beta", [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: false }) });
		expect(listAgents()).toHaveLength(6);
		expect(customAgent()).toBeUndefined();
	});
});

describe("agent catalog: names and hints", () => {
	it("names a Custom agent session by the name the user gave it", () => {
		expect(agentDisplayName({ ai_provider: "custom", agent_name: "Fake Agent" })).toBe("Fake Agent");
		expect(agentDisplayName({ ai_provider: "custom", agent_name: "  " })).toBe("Custom agent");
		expect(agentDisplayName({ ai_provider: "custom", agent_name: "x", detected_agent: { name: "Aider" } })).toBe("Aider");
		// Catalog agents keep today's behaviour: the tag appears once the agent is detected.
		expect(agentDisplayName({ ai_provider: "claude" })).toBeNull();
		expect(agentDisplayName({ ai_provider: null })).toBeNull();
	});

	it("picks the Windows install command on Windows only", () => {
		const claude = getAgent("claude");
		expect(installCommand(claude, "win")).toBe("irm https://claude.ai/install.ps1 | iex");
		expect(installCommand(claude, "mac")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
		expect(installCommand(getAgent("codex"), "win")).toBe("npm install -g @openai/codex");
		expect(installCommand(getAgent("custom"), "linux")).toBe("");
	});

	it("says how to install an agent the shell could not find", () => {
		expect(launchFailedMessage("copilot", "linux")).toBe("GitHub Copilot CLI was not found. Install with: npm install -g @github/copilot");
		expect(launchFailedMessage("custom", "linux")).toMatch(/custom agent's command was not found/);
		expect(launchFailedMessage("mystery", "linux")).toBe("mystery was not found.");
	});
});
