// ─── Starting a launcher task (F15) ────────────────────────────────────
//
// What happens after Enter in the task launcher, with every effect passed
// in so the order and the edge cases are unit-tested:
//
//   1. the repository becomes (or already is) a Hermes project;
//   2. each agent gets a session on its own new branch (the worktree is
//      made by createSession through the honest-isolation path), with the
//      task as its first prompt;
//   3. a Full-track task gets its first feature.md in each worktree;
//   4. an agent that cannot take a first prompt gets the task on the
//      clipboard instead (Hermes never types it for the user);
//   5. what was launched is recorded in the `task_launches` setting.

import type { CreateSessionOpts, SessionData } from "../types/session";
import type { TaskLaunchRequest } from "../components/TaskLauncher";
import { getAgent } from "../catalog/agentCatalog";
import { translate } from "../i18n/registry";
import {
  agentTakesFirstPrompt,
  appendTaskLaunches,
  featureMarkdown,
  parseTaskLaunches,
  taskLabel,
  taskSlug,
  type TaskLaunchRecord,
} from "./taskLauncher";

export interface LaunchTaskDeps {
  /** The project id for a repository's main checkout, creating the project if needed. */
  projectFor(repoRoot: string): Promise<string>;
  createSession(opts: CreateSessionOpts): Promise<SessionData | null>;
  /**
   * With a running-agents cap and no free slot, the session waits in the
   * task queue instead of starting (N22). True when it was queued.
   */
  queue?(opts: CreateSessionOpts, label: string): boolean;
  /** Show a new session: the first in the focused pane, a second one split beside the first. */
  place(sessionId: string, index: number, firstSessionId: string | null): void;
  worktreePath(sessionId: string, projectId: string): Promise<string | null>;
  writeFeatureFile(checkout: string, slug: string, contents: string): Promise<string>;
  copyText(text: string): Promise<void>;
  readRecords(): Promise<string>;
  writeRecords(raw: string): Promise<void>;
  now(): number;
}

export interface LaunchTaskResult {
  ok: boolean;
  sessionIds: string[];
  /** Sessions waiting in the task queue for a free slot. */
  queued: number;
  /** Agents that got the task on the clipboard instead of on their launch line. */
  copiedFor: string[];
  featureFiles: string[];
}

/** A path with its trailing separators removed (and, on Windows, case and slashes folded). */
export function normalizeRepoPath(path: string, windows = false): string {
  let p = path.trim().replace(/[\\/]+$/, "");
  if (windows) p = p.replace(/\//g, "\\").toLowerCase();
  return p || path.trim();
}

export async function launchTask(req: TaskLaunchRequest, deps: LaunchTaskDeps): Promise<LaunchTaskResult> {
  const result: LaunchTaskResult = { ok: false, sessionIds: [], queued: 0, copiedFor: [], featureFiles: [] };
  const task = req.task.trim();
  if (!task || req.agents.length === 0) return result;

  const projectId = await deps.projectFor(req.repoRoot);
  const label = taskLabel(task);
  const records: TaskLaunchRecord[] = [];

  for (const [i, agent] of req.agents.entries()) {
    const custom = getAgent(agent.id)?.custom === true;
    const opts: CreateSessionOpts = {
      label,
      aiProvider: agent.id,
      mode: agent.mode,
      projectIds: [projectId],
      workingDirectory: req.repoRoot,
      // A new worktree on a new branch, a worktree of an existing branch, or
      // (no selection) the repository's own checkout.
      branchSelections: agent.worktree
        ? { [projectId]: { branch: agent.branch, createNew: agent.createBranch, ...(agent.createBranch && agent.baseBranch ? { baseBranch: agent.baseBranch } : {}) } }
        : undefined,
      initialPrompt: task,
      permissionMode: agent.launch.permissionMode,
      customPrefix: agent.launch.customPrefix || undefined,
      customSuffix: agent.launch.customSuffix || undefined,
      channels: agent.launch.channels.length > 0 ? agent.launch.channels : undefined,
      agentName: custom ? taskLabel(agent.launch.agentCommand ?? "", 24) || undefined : undefined,
      agentCommand: custom ? agent.launch.agentCommand : undefined,
      agentLaunch: agent.launch.agentLaunch,
    };
    if (deps.queue?.(opts, label)) {
      result.queued++;
      continue;
    }
    const session = await deps.createSession(opts);
    if (!session) {
      // The first agent failing is a failed launch; a second one failing
      // leaves the first running.
      if (i === 0) return result;
      continue;
    }
    deps.place(session.id, i, result.sessionIds[0] ?? null);
    result.sessionIds.push(session.id);
    records.push({
      sessionId: session.id,
      task,
      agentId: agent.id,
      mode: agent.mode,
      repo: req.repoRoot,
      branch: agent.branch,
      track: req.track,
      doneWhen: [...req.doneWhen],
      pairedWith: null,
      createdAt: deps.now(),
    });
    if (agent.mode === "terminal" && !agentTakesFirstPrompt(agent.id)) result.copiedFor.push(agent.id);
  }
  result.ok = result.sessionIds.length > 0 || result.queued > 0;

  if (records.length === 2) {
    records[0].pairedWith = records[1].sessionId;
    records[1].pairedWith = records[0].sessionId;
  }

  if (result.copiedFor.length > 0) {
    await deps.copyText(task).catch((err) => console.warn("[launchTask] could not copy the task:", err));
  }

  if (req.track === "Full") {
    const slug = taskSlug(task) || "task";
    const contents = featureMarkdown({ slug, task, doneWhen: req.doneWhen });
    for (const id of result.sessionIds) {
      try {
        const checkout = await deps.worktreePath(id, projectId);
        if (checkout) result.featureFiles.push(await deps.writeFeatureFile(checkout, slug, contents));
      } catch (err) {
        console.warn("[launchTask] could not write feature.md:", err);
      }
    }
  }

  try {
    const existing = parseTaskLaunches(await deps.readRecords());
    await deps.writeRecords(JSON.stringify(appendTaskLaunches(existing, records)));
  } catch (err) {
    console.warn("[launchTask] could not record the launch:", err);
  }
  return result;
}

// ─── A task the agent's launch could not carry ─────────────────────────
//
// The backend starts the agent without its task when the helper launch
// falls through (no helper next to the app, for example) and says so with
// `task-prompt-undelivered`. The task goes on the clipboard and the person
// is told, instead of the task vanishing.

export interface UndeliveredTask {
  sessionId: string;
  agentId: string;
  task: string;
}

export interface UndeliveredTaskDeps {
  copyText(text: string): Promise<void>;
  notify(message: string): void;
}

export async function handleUndeliveredTask(payload: UndeliveredTask, deps: UndeliveredTaskDeps): Promise<void> {
  const task = payload.task?.trim();
  if (!task) return;
  const agent = getAgent(payload.agentId)?.name ?? payload.agentId;
  let copied = true;
  try {
    await deps.copyText(task);
  } catch (err) {
    copied = false;
    console.warn("[launchTask] could not copy the undelivered task:", err);
  }
  deps.notify(
    copied
      ? translate("launcher.taskNotDeliveredCopied", { agent })
      : translate("launcher.taskNotDelivered", { agent, task }),
  );
}
