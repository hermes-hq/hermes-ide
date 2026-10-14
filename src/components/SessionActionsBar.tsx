import { useCallback } from "react";
import { useSession } from "../state/SessionContext";
import { useI18n } from "../i18n/I18nProvider";
import { shortcutLabel } from "../utils/keymap";
import { Button } from "./ui/Button";
import { SessionActionsRow } from "./SessionActionsRow";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { agentIdOf, type SessionCommand } from "../sessionActions/catalog";
import { runInTerminal } from "../sessionActions/run";
import { takesCommands } from "../sessionActions/state";
import { getSessionStatus } from "../agent/status/attentionStore";
import { PromptsGlyph } from "../sessionActions/icons";
import type { CommandSend } from "../sessionActions/recent";
import { relaunchAgent } from "../agent/capabilities/api";
import { splitAfterCreateActions } from "../state/splitAfterCreate";
import { translate } from "../i18n/registry";
import { focusTerminal } from "../terminal/TerminalPool";

interface SessionActionsBarProps {
  sessionId: string;
  paneId: string;
  /** The focused pane: its Prompts button carries the accent. */
  focused: boolean;
  /** A short pane: the bar sits in the pane header, collapsed. */
  compact?: boolean;
}

/**
 * A terminal session's action bar: Prompts (⌘J), then the session's action
 * row (pinned actions, context, the one state chip, the Commands list).
 * Every agent gets it; an agent with no commands in the catalog shows
 * Prompts and its state chip.
 */
export function SessionActionsBar({ sessionId, paneId, focused, compact = false }: SessionActionsBarProps) {
  const { state, dispatch, createSession } = useSession();
  const { t } = useI18n();
  const session = state.sessions[sessionId];
  const agentId = session ? agentIdOf(session) : null;
  const agent = getAgent(agentId);
  const agentName = (session && agentDisplayName(session)) ?? agent?.name ?? agentId ?? "";
  const launch = session?.agent_launch ?? null;

  const run = useCallback(
    async (cmd: SessionCommand, via: CommandSend["via"]) => {
      if (!agentId) return "no_agent" as const;
      const status = getSessionStatus(sessionId);
      const reportedWaiting = status.confidence !== "guessed" && takesCommands(status.kind);
      const outcome = await runInTerminal(sessionId, agentId, cmd, via, reportedWaiting);
      // The click took the keyboard: give it back to the terminal.
      focusTerminal(sessionId);
      return outcome;
    },
    [sessionId, agentId],
  );

  // Sign in: the agent's own sign-in in a new pane beside this one (as the
  // refused-launch banner does).
  const canSignIn = !!agent?.capabilities?.accounts.login;
  const onSignIn = useCallback(() => {
    if (!agentId) return;
    void createSession({
      aiProvider: agentId,
      mode: "terminal",
      label: translate("agentError.signInSessionLabel", { agent: agent?.name ?? agentId }),
      agentLaunch: { accountId: launch?.accountId ?? null, purpose: "login" },
    }).then((created) => {
      if (!created) return;
      for (const action of splitAfterCreateActions({ paneId, sessionId }, { paneId, direction: "horizontal" }, created.id)) dispatch(action);
    });
  }, [agentId, agent, launch, createSession, dispatch, paneId, sessionId]);

  // Resume: the launch helper starts the agent again on its conversation.
  const helperEnded = session?.agent_startup?.state === "ended";
  const onResume = useCallback(() => {
    void relaunchAgent(sessionId, { modelId: launch?.modelId ?? null, effort: launch?.effort ?? null, purpose: "agent", resume: true }).catch((err: unknown) =>
      console.warn("[session-actions] resume failed:", err),
    );
  }, [sessionId, launch]);

  if (!session || session.mode === "agent" || !(agentId || session.detected_agent)) return null;

  const promptsTitle = t("composer.openPromptBuilderTitle", { shortcut: shortcutLabel("view.prompt-composer") });
  return (
    <SessionActionsRow
      className={compact ? "session-actions-bar session-actions-bar-compact" : "session-actions-bar"}
      sessionId={sessionId}
      agentId={agentId}
      agentName={agentName}
      surface="terminal"
      cwd={session.working_directory || null}
      run={run}
      forceCollapsed={compact}
      onSignIn={canSignIn ? onSignIn : undefined}
      onResume={helperEnded ? onResume : undefined}
      leading={(layout) => (
        <Button
          size="sm"
          variant={focused ? "primary" : "quiet"}
          className="sab-prompts"
          data-session-prompts=""
          icon={<PromptsGlyph />}
          title={promptsTitle}
          aria-label={layout === "collapsed" ? promptsTitle : undefined}
          onClick={() => dispatch({ type: "OPEN_COMPOSER" })}
        >
          {layout === "collapsed" ? undefined : t("palette.promptComposer")}
        </Button>
      )}
    />
  );
}
