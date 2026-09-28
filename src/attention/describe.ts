// ─── Words for an inbox item ──────────────────────────────────────────
//
// F12 + N16. What the inbox row, the OS notification and the away message
// say about an item. The away message is deliberately poorer than the rest:
// the agent, the task name and the state, never the detail line (which can
// hold a command, a question or a file path).

import type { InboxItem } from "../agent/contract/inbox";
import type { AgentStatusKind } from "../agent/contract/status";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import type { SessionData } from "../types/session";
import type { AwayPayload, NotificationText } from "./notifier";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Longest agent and task names an away message carries. */
export const AWAY_AGENT_MAX = 40;
export const AWAY_TASK_MAX = 80;

export type SessionLike = Pick<SessionData, "label" | "ai_provider"> &
  Partial<Pick<SessionData, "agent_name" | "detected_agent">>;

/** The agent's name for people ("Claude Code", "My agent"), or "Terminal". */
export function agentLabel(session: SessionLike | undefined): string {
  if (!session) return "Terminal";
  return agentDisplayName(session) ?? getAgent(session.ai_provider)?.name ?? session.ai_provider ?? "Terminal";
}

/**
 * The state an item stands for, machine-readable: the session's status kind
 * for items raised from a status ("needs_approval"), the inbox kind for the
 * rest ("gate", "error").
 */
export function itemState(item: InboxItem, status: AgentStatusKind | null): string {
  if (item.source === "status" && status) return status;
  return item.kind;
}

/** The i18n key of a state's words ("needs approval"). */
export function stateKey(state: string): string {
  return `attention.state.${state}`;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function awayPayload(item: InboxItem, session: SessionLike | undefined, status: AgentStatusKind | null): AwayPayload {
  return {
    agent: clip(agentLabel(session), AWAY_AGENT_MAX),
    task: clip(session?.label ?? "", AWAY_TASK_MAX),
    state: itemState(item, status),
  };
}

export function notificationText(
  item: InboxItem,
  session: SessionLike | undefined,
  status: AgentStatusKind | null,
  t: Translate,
): NotificationText {
  const state = t(stateKey(itemState(item, status)));
  const task = session?.label ?? t("attention.workspace");
  return {
    title: t("attention.notifyTitle", { agent: agentLabel(session), state }),
    body: item.detail ? `${task} — ${clip(item.detail, 160)}` : task,
  };
}
