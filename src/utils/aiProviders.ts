// ─── AI Provider Registry ────────────────────────────────────────────

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

export const AUTO_APPROVE_FLAGS: Record<string, { flag: string; description: string }> = {
	claude: { flag: "--dangerously-skip-permissions", description: "The AI agent can read, write, and execute without asking for confirmation." },
	gemini: { flag: "--yolo", description: "The AI agent can execute shell commands and write files without permission prompts." },
	aider: { flag: "--yes", description: "The AI agent will apply all suggested changes without asking for confirmation." },
	codex: { flag: "--full-auto", description: "The AI agent runs in fully autonomous mode without confirmation prompts." },
};

export function getProviderInfo(id: string): AiProviderInfo | undefined {
	return AI_PROVIDERS.find((p) => p.id === id);
}
