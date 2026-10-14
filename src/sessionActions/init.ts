// ─── Session actions: startup ─────────────────────────────────────────
//
// Reads the pins and the Recent lists with the other settings at startup,
// and listens for commands the person types at an agent's prompt: a line
// whose first word (or first two, as in Kiro's "/context show") names one
// of the agent's commands is kept in Recent, as that command. Anything else
// typed is not kept.

import type { SettingsMap } from "../api/settings";
import { setSubmittedCommandListener } from "../terminal/TerminalPool";
import { builtinCommands, matchTypedCommand } from "./catalog";
import { knownDiscovered } from "./discovery";
import { initPinnedActions } from "./pins";
import { forgetSessionSends, initRecentCommands, recordCommandSent } from "./recent";
import { subscribeAllSessionEvents } from "../agent/contract/sessionEventStore";

/** The agent and folder of each session whose bar is on screen. */
const sessionAgents = new Map<string, { agentId: string; cwd: string | null }>();

export function registerSessionAgent(sessionId: string, agentId: string, cwd: string | null): () => void {
  sessionAgents.set(sessionId, { agentId, cwd });
  return () => {
    if (sessionAgents.get(sessionId)?.agentId === agentId) sessionAgents.delete(sessionId);
  };
}

/** The command a line typed at the prompt names, for a session's agent. */
export function commandOfTypedLine(agentId: string, cwd: string | null, line: string) {
  const words = line.trim().split(/\s+/);
  const commands = [...builtinCommands(agentId), ...knownDiscovered(agentId, cwd)];
  return (words.length > 1 ? matchTypedCommand(`${words[0]} ${words[1]}`, commands) : undefined) ?? matchTypedCommand(words[0] ?? "", commands);
}

/** The pins and Recent lists, from the settings read at startup. */
export function initSessionActions(settings: SettingsMap): void {
  initPinnedActions(settings);
  initRecentCommands(settings);
}

/** Listen for commands typed at an agent's prompt (from startup on), and
 *  forget a closed session's sends. */
export function startSessionActions(): void {
  subscribeAllSessionEvents((sessionId, event) => {
    if (event === null) forgetSessionSends(sessionId);
  });
  setSubmittedCommandListener((sessionId, line) => {
    const known = sessionAgents.get(sessionId);
    if (!known) return;
    const cmd = commandOfTypedLine(known.agentId, known.cwd, line);
    // Kept for Recent only: typing a command is not a use of the bar (no analytics).
    if (cmd) recordCommandSent(sessionId, known.agentId, cmd.text, "typed");
  });
}
