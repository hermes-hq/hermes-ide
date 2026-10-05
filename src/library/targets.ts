// ─── Hermes agents and hodios targets ─────────────────────────────────
//
// A catalog row lists the tools it works in by hodios target id
// (claude-code, codex, gemini-cli, ...). Hermes knows agents by its own ids
// (src/catalog/agents.json). This maps one onto the other, for the "works
// in" signal, the "Works with" filter and "Install into project".

import { getAgent } from "../catalog/agentCatalog";
import type { EntryKind } from "./types";

/** Hermes agent id -> the hodios target its "works" facet uses. */
const WORKS_TARGET: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  copilot: "copilot",
  opencode: "opencode",
  antigravity: "antigravity",
};

/** Agents with no target of their own read AGENTS.md. */
export function worksTarget(agentId: string): string {
  return WORKS_TARGET[agentId] ?? "agents-md";
}

/** The Hermes agents a target stands for (claude-code -> claude). */
export function agentsForTarget(target: string): string[] {
  return Object.entries(WORKS_TARGET)
    .filter(([, t]) => t === target)
    .map(([a]) => a);
}

export function agentName(agentId: string): string {
  return getAgent(agentId)?.name ?? agentId;
}

/** The name to show for a target id ("claude-code" -> "Claude Code"). */
export function targetName(target: string): string {
  const agent = agentsForTarget(target)[0];
  if (agent) return agentName(agent);
  const known: Record<string, string> = {
    "agents-md": "AGENTS.md",
    cursor: "Cursor",
    windsurf: "Windsurf",
    zed: "Zed",
    continue: "Continue",
    chatgpt: "ChatGPT",
    "claude-ai": "claude.ai",
    mcp: "MCP",
    hermes: "Hermes",
  };
  return known[target] ?? target;
}

/**
 * The hodios-core compile target for installing a kind into a project for
 * an agent (by kind, then `*` for every other kind), or null when that agent
 * cannot carry it as a file (copy it instead). Antigravity reads
 * `.agents/skills` (the Agent Skills standard the codex target writes) and
 * AGENTS.md, until hodios ships its own target. Agents without a target of
 * their own (goose, aider, kiro, Hermes Agent, a custom command) read
 * AGENTS.md: rules, styles and personas only.
 */
const INSTALL_TARGET: Record<string, Partial<Record<EntryKind | "*", string | null>>> = {
  claude: { "*": "claude-code" },
  codex: { "*": "codex" },
  gemini: { "*": "gemini-cli" },
  copilot: { "*": "copilot" },
  opencode: { "*": "opencode" },
  antigravity: { prompt: "codex", workflow: "codex", "*": "agents-md" },
};
const AGENTS_MD_ONLY: Partial<Record<EntryKind | "*", string | null>> = { rule: "agents-md", style: "agents-md", persona: "agents-md", "*": null };

export function installTarget(agentId: string, kind: EntryKind): string | null {
  const table = INSTALL_TARGET[agentId] ?? AGENTS_MD_ONLY;
  const hit = table[kind];
  return hit !== undefined ? hit : (table["*"] ?? null);
}

/** How a person invokes an installed entry in each agent ("/review-pull-request"). */
const INVOKE: Record<string, { prefix: string; persona?: string }> = {
  claude: { prefix: "/", persona: "@" },
  codex: { prefix: "$" },
  antigravity: { prefix: "" },
};

export function invocation(agentId: string, id: string, kind: EntryKind): string | null {
  if (kind === "rule" || kind === "style") return null;
  const how = INVOKE[agentId] ?? { prefix: "/" };
  if (kind === "persona") return how.persona !== undefined ? `${how.persona}${id}` : null;
  return `${how.prefix}${id}`;
}
