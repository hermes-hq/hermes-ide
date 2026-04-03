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
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
		installCmd: "npm install -g @anthropic-ai/claude-code",
		authHint: "Run 'claude' to authenticate on first use",
	},
	{
		id: "gemini",
		label: "Gemini",
		description: "Google Gemini CLI",
		installUrl: "https://github.com/google-gemini/gemini-cli",
		installCmd: "npm install -g @anthropic-ai/gemini-cli",
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
