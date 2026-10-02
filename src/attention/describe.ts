// ─── Words for an inbox item ──────────────────────────────────────────
//
// F12 + N16. What the inbox row, the OS notification and the away message
// say about an item. The away message is deliberately poorer than the rest:
// the agent, the task name, the state and where the agent works ("api-repo
// #2"), never the detail line (which can hold a command, a question or a
// file path), and the task name only when it cannot come from a prompt (see
// userLabels.ts) or the person chose to include session names.

import type { InboxItem } from "../agent/contract/inbox";
import type { AgentStatusKind } from "../agent/contract/status";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import type { SessionData } from "../types/session";
import { isHermesWorktreePath } from "../utils/worktree";
import type { AwayPayload, NotificationText } from "./notifier";
import { shareableLabel } from "./userLabels";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Longest agent and task names an away message carries. */
export const AWAY_AGENT_MAX = 40;
export const AWAY_TASK_MAX = 80;
export const AWAY_WHERE_MAX = 80;

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

export interface AwayOptions {
  /** Where the agent works ("api-repo #2"), from awayWhere(); "" when unknown. */
  readonly where?: string;
  /** The person chose to include session names, whatever named them. */
  readonly includeNames?: boolean;
}

export function awayPayload(
  item: InboxItem,
  session: SessionLike | undefined,
  status: AgentStatusKind | null,
  { where = "", includeNames = false }: AwayOptions = {},
): AwayPayload {
  const task = includeNames ? (session?.label ?? "") : shareableLabel(item.sessionId, session?.label);
  return {
    agent: clip(agentLabel(session), AWAY_AGENT_MAX),
    task: clip(task, AWAY_TASK_MAX),
    state: itemState(item, status),
    where: clip(where, AWAY_WHERE_MAX),
  };
}

export type PlacedSession = Pick<SessionData, "id" | "working_directory" | "created_at">;

/** A home folder: /Users/<name>, /home/<name>, /root, C:/Users/<name>. Its last part is the account name. */
const HOME_DIR = /^(?:\/(?:Users|home)\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)$/i;

/**
 * The folder a session works in, by name, when that name cannot come from a
 * prompt: the project's name for a Hermes worktree (whose folder is named
 * after its branch, which can come from the task text), "~" for a home
 * folder (whose name is the account name), else the last part of the
 * working directory. Null when unknown.
 */
export function repoNameOf(session: PlacedSession, projectName: string | null | undefined): string | null {
  const dir = (session.working_directory ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (isHermesWorktreePath(`${dir}/`)) return projectName?.trim() || null;
  if (dir === "~" || HOME_DIR.test(dir)) return "~";
  return dir.split("/").pop() || null;
}

/**
 * Where an agent works, for an away message: its repository folder and its
 * number among the open sessions there, oldest first ("api-repo #2"); just
 * "#2" when the folder is unknown. Never words from a prompt.
 */
export function awayWhere(
  sessionId: string | null,
  sessions: Readonly<Record<string, PlacedSession>>,
  projectNameOf: (sessionId: string) => string | null | undefined = () => null,
): string {
  if (!sessionId) return "";
  const session = sessions[sessionId];
  if (!session) return "";
  const repo = repoNameOf(session, projectNameOf(sessionId));
  const peers = Object.entries(sessions)
    .filter(([id, s]) => repoNameOf(s, projectNameOf(id)) === repo)
    .sort(([ida, a], [idb, b]) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || ida.localeCompare(idb));
  const n = peers.findIndex(([id]) => id === sessionId) + 1;
  return repo ? `${repo} #${n}` : `#${n}`;
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
