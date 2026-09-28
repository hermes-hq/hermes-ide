// ─── Agent catalog ─────────────────────────────────────────────────────
//
// Every agent Hermes can start in a terminal lives in ./agents.json — one
// data file, validated against ./agents.schema.json by
// src/__tests__/agent-catalog.test.ts, and read by the Rust side too
// (src-tauri/src/agent_catalog.rs) so the launch line, the install hint and
// the "is it installed" check can never disagree. A nightly workflow
// (.github/workflows/agent-cli-drift.yml) installs the latest CLIs and fails
// when a flag or subcommand the catalog uses no longer exists.
//
// Entries on the "beta" channel (and the Custom agent) only show when the
// `agentCatalog` feature flag is on.

import catalogJson from "./agents.json";
import { isFeatureFlagEnabled } from "../featureFlags";
import { PLATFORM } from "../utils/platform";
import { translate } from "../i18n/registry";
import type { PermissionMode } from "../types/session";

export type AgentArgs = readonly string[];

export interface AgentSignals {
	method: "settings_file" | "config_flags" | "env_file" | "plugin_dir" | "worktree_file" | "event_stream" | "none";
	args?: AgentArgs;
	env?: Readonly<Record<string, string>>;
	files?: readonly string[];
	events?: Readonly<Record<string, readonly string[]>>;
	confidence: "exact" | "signal" | "guessed";
	note?: string;
}

export interface AgentTerminal {
	/** Starts a new session. Every other argument list is appended to it. */
	argv: AgentArgs;
	resume: {
		by_id: AgentArgs | null;
		latest: AgentArgs | null;
		/** How the vendor says a resumed conversation does not exist (read by the backend). */
		not_found?: { exit_codes?: readonly number[]; output?: readonly string[] };
	};
	new_session_id: AgentArgs | null;
	initial_prompt: AgentArgs | null;
	signals: AgentSignals;
	permission_flags: Partial<Record<PermissionMode, AgentArgs>>;
	/** Modes offered only with the agentCatalog flag on (2.0). */
	beta_permission_modes?: readonly PermissionMode[];
	min_version: string | null;
	/** Hermes's one safety default mapped to this agent (F35, see ./agentSafety.ts). */
	safety: AgentSafety;
}

export type SafetyFit = "exact" | "closest" | "stricter" | "looser" | "unknown";

export interface AgentSafety {
	/** The permission mode that comes closest to the default. */
	default_mode: PermissionMode;
	fit: SafetyFit;
	/** Argument sequences that run the agent looser than the default. */
	looser_args: readonly AgentArgs[];
	note: string;
}

/** Where an agent reads its instructions, settings, skills and MCP servers (F30). Read by the backend. */
export interface AgentSetup {
	instructions: { project: readonly string[]; global: readonly string[]; imports: boolean };
	settings: { project: readonly string[]; global: readonly string[] };
	skills: { project: readonly string[]; global: readonly string[] };
	mcp: readonly { path: string; scope: "project" | "global"; format: "json" | "toml" | "claude_local"; key: string }[] | null;
}

export interface AgentEntry {
	id: string;
	name: string;
	vendor: string | null;
	description: string;
	homepage: string | null;
	status: "current" | "legacy";
	status_note?: string;
	channel: "stable" | "beta";
	custom?: true;
	terminal: AgentTerminal;
	structured?: { protocol: "claude-agent-sdk" | "codex-app-server" | "acp"; args?: AgentArgs };
	install: { command: string; windows?: string; ci?: string; url: string } | null;
	detect: { command: AgentArgs } | null;
	auth: { check: AgentArgs | null; hint: string } | null;
	evidence: { level: "help" | "docs" | "none"; version?: string };
	setup?: AgentSetup;
}

export interface AgentCatalog {
	version: 1;
	agents: readonly AgentEntry[];
}

/** The catalog as shipped. Its shape is enforced at test time, not at runtime. */
export const AGENT_CATALOG: AgentCatalog = catalogJson as unknown as AgentCatalog;

export const CUSTOM_AGENT_ID = "custom";

/** Order of the permission pills, whatever order the catalog lists them in. */
const MODE_ORDER: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

export function getAgent(id: string | null | undefined): AgentEntry | undefined {
	if (!id) return undefined;
	return AGENT_CATALOG.agents.find((a) => a.id === id);
}

/** Whether beta entries and the Custom agent are visible. Read at call time (flags load at startup). */
export function isAgentCatalogBetaEnabled(): boolean {
	return isFeatureFlagEnabled("agentCatalog");
}

/**
 * Agents with an installable CLI that this build shows, in catalog order.
 * The Custom agent is not included: callers render it as its own card.
 */
export function listAgents(includeBeta: boolean = isAgentCatalogBetaEnabled()): AgentEntry[] {
	return AGENT_CATALOG.agents.filter((a) => !a.custom && (includeBeta || a.channel === "stable"));
}

/** The Custom agent entry, when this build shows it. */
export function customAgent(includeBeta: boolean = isAgentCatalogBetaEnabled()): AgentEntry | undefined {
	return includeBeta ? AGENT_CATALOG.agents.find((a) => a.custom) : undefined;
}

/** Permission modes an agent supports, in a fixed order. 2.0-only modes need the agentCatalog flag. */
export function getAvailableModes(agentId: string, includeBeta: boolean = isAgentCatalogBetaEnabled()): PermissionMode[] {
	const terminal = getAgent(agentId)?.terminal;
	if (!terminal) return ["default"];
	const flags = terminal.permission_flags;
	const beta = terminal.beta_permission_modes ?? [];
	return MODE_ORDER.filter((m) => flags[m] !== undefined && (includeBeta || !beta.includes(m)));
}

/** Whether `mode` is a 2.0-only mode of this agent while the agentCatalog flag is off. */
function isGatedMode(agentId: string, mode: PermissionMode): boolean {
	const beta = getAgent(agentId)?.terminal.beta_permission_modes ?? [];
	return beta.includes(mode) && !isAgentCatalogBetaEnabled();
}

/** The mode a session is started in: a 2.0-only mode falls back to default while the flag is off. */
export function launchPermissionMode(agentId: string, mode: PermissionMode): PermissionMode {
	return isGatedMode(agentId, mode) ? "default" : mode;
}

/** The launch arguments for a permission mode ("" when the mode adds none). */
export function permissionFlagText(agentId: string, mode: PermissionMode): string {
	if (isGatedMode(agentId, mode)) return "";
	return (getAgent(agentId)?.terminal.permission_flags[mode] ?? []).join(" ");
}

/** Removes line breaks from a user-typed fragment and trims it. */
export function sanitizeCommandFragment(s: string): string {
	return s.replace(/[\n\r]/g, " ").trim();
}

/**
 * The line Hermes starts the agent with, assembled exactly as the backend
 * does (src-tauri/src/pty/mod.rs ai_launch_command): prefix, the agent's
 * command (or the Custom agent's typed command), the permission-mode flags,
 * then the suffix. Returns "" for an unknown agent or an empty custom command.
 */
export function buildLaunchPreview(
	agentId: string,
	permissionMode: PermissionMode,
	customPrefix: string,
	customSuffix: string,
	customCommand: string = "",
): string {
	const agent = getAgent(agentId);
	if (!agent) return "";
	let base: string;
	if (agent.custom) {
		base = sanitizeCommandFragment(customCommand);
		if (!base) return "";
	} else {
		base = agent.terminal.argv.join(" ");
		const perm = permissionFlagText(agentId, permissionMode);
		if (perm) base += ` ${perm}`;
	}
	const parts: string[] = [];
	const prefix = sanitizeCommandFragment(customPrefix);
	const suffix = sanitizeCommandFragment(customSuffix);
	if (prefix) parts.push(prefix);
	parts.push(base);
	if (suffix) parts.push(suffix);
	return parts.join(" ");
}

/**
 * The agent name to show for a session: the detected agent, else the name
 * the user gave a Custom agent, else the catalog name of the chosen agent.
 */
export function agentDisplayName(session: {
	ai_provider?: string | null;
	agent_name?: string | null;
	detected_agent?: { name: string } | null;
}): string | null {
	if (session.detected_agent?.name) return session.detected_agent.name;
	if (session.ai_provider === CUSTOM_AGENT_ID) {
		const name = session.agent_name?.trim();
		return name ? name : getAgent(CUSTOM_AGENT_ID)?.name ?? null;
	}
	return null;
}

/** The install command for this OS ("" when the agent has none). */
export function installCommand(agent: AgentEntry | undefined, platform: "mac" | "win" | "linux" = PLATFORM): string {
	if (!agent?.install) return "";
	return (platform === "win" ? agent.install.windows : undefined) ?? agent.install.command;
}

/** The warning shown when the shell reports the agent's command as not found. */
export function launchFailedMessage(agentId: string, platform: "mac" | "win" | "linux" = PLATFORM): string {
	const agent = getAgent(agentId);
	if (!agent) return translate("session.agentLaunchFailedNoInstall", { agent: agentId });
	if (agent.custom) return translate("session.customAgentLaunchFailed");
	const command = installCommand(agent, platform);
	if (!command) return translate("session.agentLaunchFailedNoInstall", { agent: agent.name });
	return translate("session.agentLaunchFailed", { agent: agent.name, command });
}
