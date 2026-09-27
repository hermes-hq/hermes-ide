// Agent data (names, launch commands, permission flags, install hints)
// lives in the agent catalog: src/catalog/agents.json, read through
// src/catalog/agentCatalog.ts. This file keeps UI metadata that is not
// about any one agent.

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
