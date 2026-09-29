// ─── Launch options only some agents take ─────────────────────────────
//
// The task launcher offers these only for the agents that have them (the
// launch helper puts them on the agent's command line, src-tauri/src/pty/
// launch.rs).

/** Agents that take `--channels <plugin>` (Claude Code's channel plugins). */
const CHANNEL_AGENTS: ReadonlySet<string> = new Set(["claude"]);

export function takesChannels(agentId: string | null | undefined): boolean {
  return !!agentId && CHANNEL_AGENTS.has(agentId);
}
