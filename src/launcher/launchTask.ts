// ─── Starting a launcher task (F15) ────────────────────────────────────
//
// What happens after Enter in the task launcher, with every effect passed
// in so the order and the edge cases are unit-tested:
//
//   1. the repository becomes (or already is) a Hermes project;
//   2. each agent gets a session on its own new branch (the worktree is
//      made by createSession through the honest-isolation path), with the
//      task as its first prompt — for a task tracked as a feature, the task
//      wrapped in the track's rules and the first phase's instructions, so
//      the agent writes questions.md and stops at the gate instead of doing
//      the whole task;
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

/**
 * One agent of a launch that waits in the task queue: everything its start
 * needs to finish the launch exactly as an immediate one would (the
 * feature.md, the checks, the launch record, the pairing with the other
 * agent of the same launch). Plain data: the queue keeps it across a quit.
 */
export interface QueuedLaunch {
  req: TaskLaunchRequest;
  agentIndex: number;
  projectId: string;
  /** Shared by the agents of one launch (pairs their records). */
  launchId: string;
  /** The first prompt the agent starts with (the track's, for a Full track). */
  firstPrompt: string;
}

export interface LaunchTaskDeps {
  /** The project id for a repository's main checkout, creating the project if needed. */
  projectFor(repoRoot: string): Promise<string>;
  createSession(opts: CreateSessionOpts): Promise<SessionData | null>;
  /**
   * With a running-agents cap and no free slot, the session waits in the
   * task queue instead of starting (N22). True when it was queued; `launch`
   * is what finishes the launch once it starts (finishQueuedLaunch).
   */
  queue?(opts: CreateSessionOpts, label: string, launch: QueuedLaunch): boolean;
  /** Show a new session: the first in the focused pane, a second one split beside the first. */
  place(sessionId: string, index: number, firstSessionId: string | null): void;
  /** The session's linked worktree, or null when it runs in the repository's own checkout. */
  worktreePath(sessionId: string, projectId: string): Promise<string | null>;
  writeFeatureFile(checkout: string, slug: string, contents: string): Promise<string>;
  /**
   * The task's checks, kept in the worktree's git folder (never in the
   * repository), where `hi check` finds them for that worktree only.
   */
  writeDoneWhen?(checkout: string, commands: string[]): Promise<string>;
  /** The first prompt of a Full-track task (taskTrackPrompt). */
  trackPrompt?(repoRoot: string, slug: string, task: string): Promise<string>;
  copyText(text: string): Promise<void>;
  readRecords(): Promise<string>;
  writeRecords(raw: string): Promise<void>;
  now(): number;
  /** Tells the person something went wrong after the launch itself succeeded. */
  notify?(message: string): void;
  /** An id for this launch (records of its agents share it). */
  newLaunchId?(): string;
}

export interface LaunchTaskResult {
  ok: boolean;
  sessionIds: string[];
  /** Sessions waiting in the task queue for a free slot. */
  queued: number;
  /** Agents that got the task on the clipboard instead of on their launch line. */
  copiedFor: string[];
  featureFiles: string[];
  /** This launch's id (its queued agents carry it). */
  launchId?: string;
}

/** A path with its trailing separators removed (and, on Windows, case and slashes folded). */
export function normalizeRepoPath(path: string, windows = false): string {
  let p = path.trim().replace(/[\\/]+$/, "");
  if (windows) p = p.replace(/\//g, "\\").toLowerCase();
  return p || path.trim();
}

/** The create_session options of one agent of a launch. */
function sessionOpts(launch: QueuedLaunch): CreateSessionOpts {
  const { req, agentIndex, projectId, firstPrompt } = launch;
  const agent = req.agents[agentIndex];
  const custom = getAgent(agent.id)?.custom === true;
  return {
    label: taskLabel(req.task),
    aiProvider: agent.id,
    mode: agent.mode,
    projectIds: [projectId],
    workingDirectory: req.repoRoot,
    // A new worktree on a new branch, a worktree of an existing branch, or
    // (no selection) the repository's own checkout.
    branchSelections: agent.worktree
      ? { [projectId]: { branch: agent.branch, createNew: agent.createBranch, ...(agent.createBranch && agent.baseBranch ? { baseBranch: agent.baseBranch } : {}) } }
      : undefined,
    initialPrompt: firstPrompt,
    permissionMode: agent.launch.permissionMode,
    customPrefix: agent.launch.customPrefix || undefined,
    customSuffix: agent.launch.customSuffix || undefined,
    channels: agent.launch.channels.length > 0 ? agent.launch.channels : undefined,
    agentName: custom ? taskLabel(agent.launch.agentCommand ?? "", 24) || undefined : undefined,
    agentCommand: custom ? agent.launch.agentCommand : undefined,
    agentLaunch: agent.launch.agentLaunch,
  };
}

/**
 * What a started agent session of a launch still needs: the Full track's
 * feature.md (in its worktree, or in the repository's own checkout when it
 * runs there), the task's checks next to its worktree, and its record.
 */
async function finishAgent(launch: QueuedLaunch, sessionId: string, deps: LaunchTaskDeps, result: LaunchTaskResult): Promise<TaskLaunchRecord> {
  const { req, agentIndex, projectId } = launch;
  const agent = req.agents[agentIndex];
  const task = req.task.trim();
  let worktree: string | null = null;
  try {
    worktree = await deps.worktreePath(sessionId, projectId);
  } catch (err) {
    console.warn("[launchTask] could not read the session's worktree:", err);
  }
  if (req.track === "Full") {
    const slug = taskSlug(task) || "task";
    // A session on the current checkout has no worktree: the feature lives in the repository's own folder.
    const checkout = worktree ?? (agent.worktree ? null : req.repoRoot);
    try {
      if (!checkout) throw new Error(translate("launcher.featureNoCheckout"));
      result.featureFiles.push(await deps.writeFeatureFile(checkout, slug, featureMarkdown({ slug, task, doneWhen: req.doneWhen })));
    } catch (err) {
      console.warn("[launchTask] could not write feature.md:", err);
      deps.notify?.(translate("launcher.featureTrackFailed", { reason: err instanceof Error ? err.message : String(err) }));
    }
  }
  const checks = req.doneWhen.map((c) => c.trim()).filter(Boolean);
  if (worktree && checks.length > 0 && deps.writeDoneWhen) {
    try {
      await deps.writeDoneWhen(worktree, checks);
    } catch (err) {
      console.warn("[launchTask] could not keep the task's checks:", err);
    }
  }
  if (agent.mode === "terminal" && !agentTakesFirstPrompt(agent.id)) result.copiedFor.push(agent.id);
  return {
    sessionId,
    task,
    agentId: agent.id,
    mode: agent.mode,
    repo: req.repoRoot,
    branch: agent.branch,
    track: req.track,
    doneWhen: [...req.doneWhen],
    pairedWith: null,
    createdAt: deps.now(),
    launchId: launch.launchId,
  };
}

async function saveRecords(records: readonly TaskLaunchRecord[], deps: LaunchTaskDeps): Promise<void> {
  if (records.length === 0) return;
  try {
    const existing = parseTaskLaunches(await deps.readRecords());
    await deps.writeRecords(JSON.stringify(appendTaskLaunches(existing, records)));
  } catch (err) {
    console.warn("[launchTask] could not record the launch:", err);
  }
}

function newLaunchId(deps: LaunchTaskDeps): string {
  if (deps.newLaunchId) return deps.newLaunchId();
  return `launch-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function launchTask(req: TaskLaunchRequest, deps: LaunchTaskDeps): Promise<LaunchTaskResult> {
  const result: LaunchTaskResult = { ok: false, sessionIds: [], queued: 0, copiedFor: [], featureFiles: [] };
  const task = req.task.trim();
  if (!task || req.agents.length === 0) return result;

  const projectId = await deps.projectFor(req.repoRoot);
  const label = taskLabel(task);
  const slug = taskSlug(task) || "task";
  // A Full track drives the agent phase by phase from its first prompt. When
  // the prompt cannot be built the launch still goes, with the bare task.
  let firstPrompt = task;
  if (req.track === "Full" && deps.trackPrompt) {
    try {
      firstPrompt = await deps.trackPrompt(req.repoRoot, slug, task);
    } catch (err) {
      console.warn("[launchTask] could not build the feature track's first prompt:", err);
    }
  }
  const launchId = newLaunchId(deps);
  result.launchId = launchId;
  const plan = (agentIndex: number): QueuedLaunch => ({ req: { ...req, task }, agentIndex, projectId, launchId, firstPrompt });

  const started: { sessionId: string; launch: QueuedLaunch }[] = [];
  for (const i of req.agents.keys()) {
    const launch = plan(i);
    const opts = sessionOpts(launch);
    if (deps.queue?.(opts, label, launch)) {
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
    started.push({ sessionId: session.id, launch });
  }
  result.ok = result.sessionIds.length > 0 || result.queued > 0;

  const records: TaskLaunchRecord[] = [];
  for (const s of started) records.push(await finishAgent(s.launch, s.sessionId, deps, result));

  if (result.copiedFor.length > 0) {
    await deps.copyText(firstPrompt).catch((err) => console.warn("[launchTask] could not copy the task:", err));
  }
  await saveRecords(records, deps);
  return result;
}

/**
 * A queued agent of a launch has started (its session was created when a
 * slot freed, or by "Start now"): the rest of its launch, as launchTask does
 * it for an agent that starts at once.
 */
export async function finishQueuedLaunch(launch: QueuedLaunch, sessionId: string, deps: LaunchTaskDeps): Promise<LaunchTaskResult> {
  const result: LaunchTaskResult = { ok: true, sessionIds: [sessionId], queued: 0, copiedFor: [], featureFiles: [], launchId: launch.launchId };
  const record = await finishAgent(launch, sessionId, deps, result);
  if (result.copiedFor.length > 0) {
    await deps.copyText(launch.firstPrompt).catch((err) => console.warn("[launchTask] could not copy the task:", err));
  }
  await saveRecords([record], deps);
  return result;
}

/** The create_session options a queued launch starts with. */
export function queuedLaunchOpts(launch: QueuedLaunch): CreateSessionOpts {
  return sessionOpts(launch);
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
