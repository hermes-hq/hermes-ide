// ─── Session actions in the command palette (⌘K) ──────────────────────
//
// With a session focused, the palette lists its agent's commands as "Run
// in <session>: Compact". A pick goes to that session's action bar (see
// ./requests), which applies the bar's rules: only while the agent waits,
// never over a draft, a destructive command asks first.

import type { SessionData } from "../types/session";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { agentIdOf, builtinCommands } from "./catalog";
import { knownDiscovered } from "./discovery";
import { canRequestSessionCommand, requestSessionCommand } from "./requests";
import { commandLabel } from "./text";

type T = (key: string, values?: Record<string, string | number>) => string;

export interface PaletteSessionCommand {
  id: string;
  label: string;
  category: string;
  run: () => void;
}

export function paletteSessionCommands(session: SessionData | null | undefined, t: T): PaletteSessionCommand[] {
  if (!session || !canRequestSessionCommand(session.id)) return [];
  const agentId = agentIdOf(session);
  if (!agentId) return [];
  const agentName = agentDisplayName(session) ?? getAgent(agentId)?.name ?? agentId;
  const commands = [...builtinCommands(agentId), ...knownDiscovered(agentId, session.working_directory || null)];
  const seen = new Set<string>();
  return commands
    .filter((c) => !seen.has(c.text) && seen.add(c.text))
    .map((c) => ({
      id: `session-command-${c.text}`,
      label: t("sessionActions.runInSession", { session: session.label, command: commandLabel(c, t) }),
      category: `${agentName} · ${c.text}`,
      run: () => {
        requestSessionCommand(session.id, c.text);
      },
    }));
}
