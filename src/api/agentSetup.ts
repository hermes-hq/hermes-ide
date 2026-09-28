import { invoke } from "@tauri-apps/api/core";

/** One instruction file, settings file or skill an agent reads (src-tauri/src/agent_setup.rs). */
export interface SetupItem {
  path: string;
  /** `~/...` for the home folder, else relative to its folder. */
  display: string;
  name: string;
  scope: "global" | "project" | "attached";
  folder: string | null;
  /** Whether the agent loads it when started in the session's folder. */
  loaded: boolean;
  /** For an imported file: the file that imports it. */
  via: string | null;
}

export interface McpServerItem {
  name: string;
  source: string;
  scope: "global" | "project" | "local" | "attached";
  loaded: boolean;
}

export interface AgentMcp {
  agentId: string;
  agentName: string;
  servers: McpServerItem[];
}

export interface AgentSetupOverview {
  agentId: string;
  agentName: string;
  known: boolean;
  instructions: SetupItem[];
  settings: SetupItem[];
  skills: SetupItem[];
  mcp: AgentMcp[];
  link: { folder: string; file: string; target: string } | null;
}

/**
 * What `agentId` loads when started in `cwd`, plus the session's attached
 * folders (read-only). `includeMcp: false` leaves out the MCP servers (and
 * the config files they are read from).
 */
export function getAgentSetupOverview(agentId: string, cwd: string, attached: string[], includeMcp = true): Promise<AgentSetupOverview> {
  return invoke<AgentSetupOverview>("agent_setup_overview", { agentId, cwd, attached, includeMcp });
}

/** Adds `@AGENTS.md` to the agent's own instruction file in `folder`. */
export function linkInstructionsToAgentsMd(agentId: string, folder: string): Promise<"created" | "updated" | "already"> {
  return invoke<"created" | "updated" | "already">("link_instructions_to_agents_md", { agentId, folder });
}

/** Command lines of the catalog agents running under a session's shell, each from the agent's command on. */
export function getSessionProcessArgv(sessionId: string): Promise<string[][]> {
  return invoke<string[][]>("session_process_argv", { sessionId });
}
