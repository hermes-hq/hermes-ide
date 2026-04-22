// ─── AI Provider Registry ────────────────────────────────────────────

import type { PermissionMode } from "../types/session";

export interface AiProviderInfo {
	id: string;
	label: string;
	description: string;
	installUrl: string;
	installCmd: string;
	authHint: string;
}

export const AI_PROVIDERS: AiProviderInfo[] = [
	{
		id: "claude",
		label: "Claude",
		description: "Claude Code CLI",
		installUrl: "https://claude.ai/claude-code",
		installCmd: "npm install -g @anthropic-ai/claude-code",
		authHint: "Run 'claude' to authenticate on first use",
	},
	{
		id: "gemini",
		label: "Gemini",
		description: "Google Gemini CLI",
		installUrl: "https://github.com/google-gemini/gemini-cli",
		installCmd: "npm install -g @google/gemini-cli",
		authHint: "Run 'gemini' to sign in with Google on first use",
	},
	{
		id: "aider",
		label: "Aider",
		description: "Aider AI pair programming",
		installUrl: "https://aider.chat/docs/install.html",
		installCmd: "pip install aider-chat",
		authHint: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY env var",
	},
	{
		id: "codex",
		label: "Codex",
		description: "OpenAI Codex CLI",
		installUrl: "https://github.com/openai/codex",
		installCmd: "npm install -g @openai/codex",
		authHint: "Run 'codex' to authenticate on first use",
	},
	{
		id: "copilot",
		label: "Copilot",
		description: "GitHub Copilot CLI",
		installUrl: "https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line",
		installCmd: "gh extension install github/gh-copilot",
		authHint: "Run 'gh auth login' first, then install the extension",
	},
	{
		id: "kiro",
		label: "Kiro",
		description: "Kiro CLI (AWS)",
		installUrl: "https://kiro.dev/docs/cli/installation/",
		installCmd: "npm install -g kiro-cli",
		authHint: "Run 'kiro-cli login' to authenticate on first use",
	},
];

// ─── Permission Mode Metadata ────────────────────────────────────────

export interface PermissionModeInfo {
	label: string;
	shortLabel: string;
	description: string;
}

export const PERMISSION_MODES: Record<PermissionMode, PermissionModeInfo> = {
	default: {
		label: "Ask Permissions",
		shortLabel: "Default",
		description: "The AI asks before editing files or running commands.",
	},
	acceptEdits: {
		label: "Accept Edits",
		shortLabel: "Accept Edits",
		description: "Auto-accept file edits, still ask for shell commands.",
	},
	plan: {
		label: "Plan Mode",
		shortLabel: "Plan",
		description: "Read-only exploration and planning — no edits allowed.",
	},
	auto: {
		label: "Auto Mode",
		shortLabel: "Auto",
		description: "Background classifier handles approvals automatically.",
	},
	dontAsk: {
		label: "Don't Ask",
		shortLabel: "Don't Ask",
		description: "Execute all actions without asking. Still applies safety guardrails.",
	},
	bypassPermissions: {
		label: "Bypass Permissions",
		shortLabel: "Bypass",
		description: "No permission checks at all. Use with caution.",
	},
};

// ─── Provider → Permission Mode Flag Mapping ─────────────────────────

export interface PermissionModeFlag {
	flag: string;
	description: string;
}

export const PERMISSION_MODE_FLAGS: Record<string, Partial<Record<PermissionMode, PermissionModeFlag>>> = {
	claude: {
		default:           { flag: "", description: "Default behavior — asks before each action." },
		acceptEdits:       { flag: "--permission-mode acceptEdits", description: "Auto-accept file edits, still ask for commands." },
		plan:              { flag: "--permission-mode plan", description: "Read-only exploration, no edits." },
		auto:              { flag: "--permission-mode auto", description: "Background classifier handles approvals." },
		dontAsk:           { flag: "--permission-mode dontAsk", description: "Execute all actions without asking. Safety guardrails still apply." },
		bypassPermissions: { flag: "--permission-mode bypassPermissions", description: "No permission checks (dangerous)." },
	},
	aider: {
		default:           { flag: "", description: "Default behavior — asks before applying changes." },
		auto:              { flag: "--yes", description: "Auto-apply changes without confirmation." },
		bypassPermissions: { flag: "--yes-always", description: "Always say yes to every confirmation." },
	},
	codex: {
		default:           { flag: "", description: "Default behavior — asks for approval on each command." },
		auto:              { flag: "--full-auto", description: "Workspace-write sandbox with on-request approvals." },
		bypassPermissions: { flag: "--dangerously-bypass-approvals-and-sandbox", description: "No approvals or sandboxing (dangerous)." },
	},
	gemini: {
		default:           { flag: "", description: "Default behavior." },
		bypassPermissions: { flag: "--yolo", description: "Execute commands and write files without prompts." },
	},
	copilot: {
		default:           { flag: "", description: "Default behavior." },
	},
	kiro: {
		default:           { flag: "", description: "Default behavior — asks before executing tools." },
		auto:              { flag: "--trust-tools", description: "Trust all tools without confirmation prompts." },
	},
};

/** Get the permission modes available for a specific provider. */
export function getAvailableModes(providerId: string): PermissionMode[] {
	const flags = PERMISSION_MODE_FLAGS[providerId];
	if (!flags) return ["default"];
	return Object.keys(flags) as PermissionMode[];
}

/** @deprecated Use PERMISSION_MODE_FLAGS instead. */
export const AUTO_APPROVE_FLAGS: Record<string, { flag: string; description: string }> = {
	claude: { flag: "--dangerously-skip-permissions", description: "The AI agent can read, write, and execute without asking for confirmation." },
	gemini: { flag: "--yolo", description: "The AI agent can execute shell commands and write files without permission prompts." },
	aider: { flag: "--yes-always", description: "The AI agent will apply all suggested changes without asking for confirmation." },
	codex: { flag: "--dangerously-bypass-approvals-and-sandbox", description: "The AI agent runs without approvals or sandboxing." },
};

export function getProviderInfo(id: string): AiProviderInfo | undefined {
	return AI_PROVIDERS.find((p) => p.id === id);
}

// ─── Per-agent Prefix Command ────────────────────────────────────────
//
// The prefix is prepended to the AI-agent launch string (e.g. `caffeinate -i
// claude`, `wsl claude`, `nice -n 10 claude`). It is stored in the settings
// table under a single JSON-blob key, mapping provider id → prefix string.

export const AI_AGENT_PREFIXES_KEY = "ai_agent_prefixes";

export type AgentPrefixMap = Record<string, string>;

/** Parse the `ai_agent_prefixes` setting value. Returns {} on any error. */
export function parseAgentPrefixes(raw: string | null | undefined): AgentPrefixMap {
	if (!raw) return {};
	try {
		const obj = JSON.parse(raw);
		if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
		const out: AgentPrefixMap = {};
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === "string") out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** Serialize an AgentPrefixMap for persistence. Drops empty/whitespace-only values. */
export function serializeAgentPrefixes(map: AgentPrefixMap): string {
	const filtered: AgentPrefixMap = {};
	for (const [k, v] of Object.entries(map)) {
		const trimmed = v.trim();
		if (trimmed) filtered[k] = trimmed;
	}
	return JSON.stringify(filtered);
}

/** Platform identifier used by prefix examples. */
export type PrefixPlatform = "mac" | "win" | "linux";

export interface PrefixExample {
	/** Command to insert (e.g. "caffeinate -i"). */
	value: string;
	/** Short human label shown on the chip (e.g. "caffeinate"). */
	label: string;
	/** Tooltip / hint describing what the wrapper does. */
	hint: string;
}

/**
 * OS-appropriate examples surfaced as click-to-insert chips under the prefix
 * input. The list is intentionally small — discoverability first, not
 * completeness. Users type anything they want in the free-text field.
 */
export const PREFIX_EXAMPLES: Record<PrefixPlatform, PrefixExample[]> = {
	mac: [
		{ value: "caffeinate -i", label: "caffeinate", hint: "Keep the Mac awake while the agent runs" },
		{ value: "nice -n 10", label: "nice", hint: "Lower scheduling priority so the agent doesn't hog the CPU" },
		{ value: "time", label: "time", hint: "Print timing info when the agent exits" },
	],
	win: [
		{ value: "wsl", label: "wsl", hint: "Run the agent inside Windows Subsystem for Linux" },
		{ value: "pwsh -NoProfile -Command", label: "pwsh", hint: "Run via PowerShell without loading the user profile" },
	],
	linux: [
		{ value: "nice -n 10", label: "nice", hint: "Lower scheduling priority so the agent doesn't hog the CPU" },
		{ value: "systemd-run --user --scope", label: "systemd-run", hint: "Run as a transient systemd user scope (isolated cgroup)" },
		{ value: "ionice -c 3", label: "ionice", hint: "Run at idle I/O priority" },
		{ value: "time", label: "time", hint: "Print timing info when the agent exits" },
	],
};

/** Placeholder string for the prefix input, based on current platform. */
export function getPrefixPlaceholder(platform: PrefixPlatform): string {
	const first = PREFIX_EXAMPLES[platform][0];
	return first ? `e.g. ${first.value}` : "";
}

/** Binary name spawned by the Rust backend for each provider — mirrors the
 *  match block in `ai_launch_command()` in `src-tauri/src/pty/mod.rs`. */
const PROVIDER_BINARY: Record<string, string> = {
	claude: "claude",
	gemini: "gemini",
	aider: "aider",
	codex: "codex",
	copilot: "gh copilot",
	kiro: "kiro-cli",
};

/**
 * Assemble the launch command exactly the way the backend does, so UI previews
 * stay truthful. Prefix is prepended, permission-mode flag (if any) goes next,
 * suffix is appended last. Each fragment is trimmed; empty fragments collapse.
 */
export function buildLaunchPreview(
	providerId: string,
	permissionMode: PermissionMode,
	customPrefix: string,
	customSuffix: string,
): string {
	const base = PROVIDER_BINARY[providerId];
	if (!base) return "";
	const permFlag = PERMISSION_MODE_FLAGS[providerId]?.[permissionMode]?.flag ?? "";
	const sanitize = (s: string) => s.replace(/[\n\r]/g, " ").trim();
	const prefix = sanitize(customPrefix);
	const suffix = sanitize(customSuffix);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	parts.push(base + (permFlag ? ` ${permFlag}` : ""));
	if (suffix) parts.push(suffix);
	return parts.join(" ");
}
