import { useCallback, useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { SessionActionsRow, type ActionOverride } from "./SessionActionsRow";
import { getOrCreateAgentSessionStore } from "../agent/agentSessionStore";
import { selectWorkingState } from "../agent/workingState";
import type { SessionActionId, SessionCommand } from "../sessionActions/catalog";
import { noteSent, type RunOutcome } from "../sessionActions/run";
import type { CommandSend } from "../sessionActions/recent";

/** Whether the Agent view's agent is working (streaming a reply or running a tool). */
function useAgentWorking(sessionId: string): boolean {
  const store = useMemo(() => getOrCreateAgentSessionStore(sessionId, listen), [sessionId]);
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selectWorkingState(store.getSnapshot().state).active,
  );
}

export interface AgentActionsRowProps {
  sessionId: string;
  agentName: string;
  cwd: string | null;
  /** The live slash commands the agent reported (the composer's "/" list). */
  liveCommands: readonly { command: string; description?: string }[];
  /** The composer's draft (text or images) is not empty. */
  hasDraft: boolean;
  /** Sends a command line the way the composer sends one it was given (native, or the embedded terminal). */
  sendCommand: (text: string) => Promise<void>;
  /** The composer's permission mode, and how to switch it (Plan). */
  permissionMode: string;
  setPermissionMode: (mode: string) => void;
}

/**
 * The Agent view's action row, above its composer: the same row as a
 * terminal pane's (context, pinned actions, the state chip, Commands), sent
 * through the composer's own path and its live slash list. The composer's
 * model chip is the Model action here, so the row does not repeat it; Plan
 * switches the composer's permission mode to plan and back.
 */
export function AgentActionsRow({ sessionId, agentName, cwd, liveCommands, hasDraft, sendCommand, permissionMode, setPermissionMode }: AgentActionsRowProps) {
  const working = useAgentWorking(sessionId);

  const live = useMemo<SessionCommand[]>(
    () =>
      liveCommands.map((c) => ({
        text: c.command,
        label: c.command,
        description: c.description ?? "",
        category: "session",
        destructive: false,
        aliases: [],
        source: "builtin",
      })),
    [liveCommands],
  );

  const run = useCallback(
    async (cmd: SessionCommand, via: CommandSend["via"]): Promise<RunOutcome> => {
      if (working) return "busy";
      if (hasDraft) return "draft";
      try {
        await sendCommand(cmd.text);
      } catch {
        return "error";
      }
      noteSent(sessionId, "claude", cmd, via);
      return "sent";
    },
    [working, hasDraft, sendCommand, sessionId],
  );

  const override = useCallback(
    (action: SessionActionId): ActionOverride | undefined => {
      if (action === "model") return { hidden: true };
      if (action === "plan") {
        const on = permissionMode === "plan";
        return { pressed: on, onPress: () => setPermissionMode(on ? "default" : "plan") };
      }
      return undefined;
    },
    [permissionMode, setPermissionMode],
  );

  return (
    <SessionActionsRow
      className="agent-actions-row"
      sessionId={sessionId}
      agentId="claude"
      agentName={agentName}
      surface="agent"
      cwd={cwd}
      run={run}
      ready={!working}
      actionOverride={override}
      liveCommands={live}
    />
  );
}
