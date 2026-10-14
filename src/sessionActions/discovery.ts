// ─── Session actions: the person's own commands ───────────────────────
//
// "Your commands" in the Commands list: the command and skill files the
// agent itself reads (src-tauri/src/agent_commands.rs, from the folders
// the agent catalog names), in the session's folder and the home folder.
// Read when the list opens and kept per agent and folder for the session's
// typed-command matching; a later open reads them again.

import { invoke } from "@tauri-apps/api/core";
import type { SessionCommand } from "./catalog";

/** As the backend sends it (camelCase). */
export interface DiscoveredCommand {
  invocation: string;
  description: string | null;
  argumentHint: string | null;
  kind: "command" | "skill";
  scope: "project" | "user";
  path: string;
}

const cache = new Map<string, readonly SessionCommand[]>();
const key = (agentId: string, cwd: string | null) => `${agentId}\u0000${cwd ?? ""}`;

/** Pure: a discovered file as a command row (`library`: Hermes installed it from the Library). */
export function toSessionCommand(d: DiscoveredCommand, library = false): SessionCommand {
  return {
    text: d.invocation,
    label: d.invocation,
    description: d.description ?? "",
    category: "project",
    destructive: false,
    aliases: [],
    source: library ? "library" : "user",
    scope: d.scope,
    kind: d.kind,
    argumentHint: d.argumentHint ?? undefined,
  };
}

/** Read the person's commands for an agent in a folder (never rejects). */
export async function discoverCommands(agentId: string, cwd: string | null): Promise<DiscoveredCommand[]> {
  try {
    return await invoke<DiscoveredCommand[]>("discover_agent_commands", { agentId, cwd });
  } catch (err) {
    console.warn("[session-actions] could not read your commands:", err);
    return [];
  }
}

export function rememberDiscovered(agentId: string, cwd: string | null, commands: readonly SessionCommand[]): void {
  cache.set(key(agentId, cwd), commands);
}

/** The last list read for an agent in a folder ([] before the first read). */
export function knownDiscovered(agentId: string, cwd: string | null): readonly SessionCommand[] {
  return cache.get(key(agentId, cwd)) ?? [];
}
