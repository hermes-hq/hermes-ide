// ─── Handoff (N19): starting the new session ──────────────────────────
//
// "Continue": the new session is linked to the SAME checkout as the one it
// takes over (per project), on purpose — that is the point of continuing.
// "Duplicate": each project gets a new worktree on a child branch cut from
// the parent's branch. Then the session is created with the seed as its
// first prompt (a launch argument, see handoff.ts) and shown under its
// parent. Anything made for a handoff that fails is undone.
//
// The I/O comes in as `deps`, so the order and the undo are unit-tested.

import { getAvailableModes } from "../catalog/agentCatalog";
import type { SessionWorktree } from "../types/git";
import type { CreateSessionOpts, PermissionMode, SessionData } from "../types/session";
import { childBranchName, handoffLabel, type HandoffKind } from "./handoff";

export interface HandoffDeps {
  newSessionId(): string;
  sessionProjects(sessionId: string): Promise<ReadonlyArray<{ id: string }>>;
  worktreeInfo(sessionId: string, projectId: string): Promise<SessionWorktree | null>;
  branchNames(projectId: string): Promise<readonly string[]>;
  createWorktree(
    sessionId: string,
    projectId: string,
    branch: string,
    createNew: boolean,
    fromRemote?: string,
    baseBranch?: string,
  ): Promise<unknown>;
  attachWorktree(sessionId: string, projectId: string, branch: string): Promise<unknown>;
  removeWorktree(sessionId: string, projectId: string): Promise<unknown>;
  detachWorktree(sessionId: string, projectId: string): Promise<unknown>;
  createSession(opts: CreateSessionOpts): Promise<SessionData | null>;
  setGroup(sessionId: string, group: string | null): Promise<unknown>;
}

export interface HandoffRequest {
  readonly kind: HandoffKind;
  readonly parent: SessionData;
  readonly agentId: string;
  readonly seed: string;
}

export interface HandoffResult {
  readonly session: SessionData;
  /** Per project: the branch the new session works on. */
  readonly branches: Readonly<Record<string, string>>;
}

/** Thrown when there is nothing to duplicate from (no project on a branch). */
export class HandoffError extends Error {
  constructor(readonly code: "no_branch" | "not_created", message: string) {
    super(message);
  }
}

/**
 * Plan the checkout of every project the parent has: `attach` the parent's
 * branch (continue) or `create` a child branch from it (duplicate). A
 * project with no worktree link (the session works in a plain folder) is
 * left to the working directory for continue, and skipped for duplicate.
 */
export async function planCheckouts(
  req: HandoffRequest,
  deps: Pick<HandoffDeps, "sessionProjects" | "worktreeInfo" | "branchNames">,
): Promise<{ projectIds: string[]; steps: Array<{ projectId: string; branch: string; base: string | null }> }> {
  const projects = await deps.sessionProjects(req.parent.id);
  const projectIds = projects.map((p) => p.id);
  const steps: Array<{ projectId: string; branch: string; base: string | null }> = [];
  for (const projectId of projectIds) {
    const wt = await deps.worktreeInfo(req.parent.id, projectId);
    const branch = wt?.branchName ?? null;
    if (!branch) continue;
    if (req.kind === "continue") {
      steps.push({ projectId, branch, base: null });
    } else {
      const existing = await deps.branchNames(projectId);
      steps.push({ projectId, branch: childBranchName(branch, req.agentId, existing), base: branch });
    }
  }
  if (req.kind === "duplicate" && steps.length === 0) {
    throw new HandoffError("no_branch", "this session is not on a branch of a git project, so there is nothing to duplicate from");
  }
  return { projectIds, steps };
}

export async function runHandoff(req: HandoffRequest, deps: HandoffDeps): Promise<HandoffResult> {
  const { projectIds, steps } = await planCheckouts(req, deps);
  const sessionId = deps.newSessionId();
  const made: Array<{ projectId: string; attached: boolean }> = [];
  const undo = async () => {
    for (const m of made.reverse()) {
      try {
        if (m.attached) await deps.detachWorktree(sessionId, m.projectId);
        else await deps.removeWorktree(sessionId, m.projectId);
      } catch (e) {
        console.warn(`[handoff] could not undo the checkout for project ${m.projectId}:`, e);
      }
    }
  };

  const branches: Record<string, string> = {};
  try {
    for (const step of steps) {
      if (step.base === null) {
        await deps.attachWorktree(sessionId, step.projectId, step.branch);
        made.push({ projectId: step.projectId, attached: true });
      } else {
        await deps.createWorktree(sessionId, step.projectId, step.branch, true, undefined, step.base);
        made.push({ projectId: step.projectId, attached: false });
      }
      branches[step.projectId] = step.branch;
    }

    const modes = getAvailableModes(req.agentId);
    const permissionMode: PermissionMode = modes.includes(req.parent.permission_mode as PermissionMode)
      ? (req.parent.permission_mode as PermissionMode)
      : "default";
    const session = await deps.createSession({
      sessionId,
      label: handoffLabel(req.parent.label, req.agentId),
      color: req.parent.color || undefined,
      workingDirectory: req.parent.working_directory,
      aiProvider: req.agentId,
      permissionMode,
      projectIds: projectIds.length > 0 ? projectIds : undefined,
      seedPrompt: req.seed,
      parentSessionId: req.parent.id,
    });
    if (!session) throw new HandoffError("not_created", "the new session could not be started");
    if (req.parent.group) {
      await deps.setGroup(session.id, req.parent.group).catch((e) => console.warn("[handoff] could not set the project group:", e));
    }
    return { session, branches };
  } catch (e) {
    await undo();
    throw e;
  }
}
