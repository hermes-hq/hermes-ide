// ─── Handoff (N19): continue or duplicate a task in another agent ─────
//
// "Continue in another agent" starts a session in the SAME checkout, seeded
// with the task and the files changed so far; "Duplicate to another agent"
// runs the same task on a child branch of its own, `hermes/<slug>--<agent>`
// (git refuses `~` in a branch name, so the plan's `hermes/<slug>~<agent>`
// is spelled with `--`).
//
// The seed is the new agent's first prompt and travels ONLY as a launch
// argument through the `hi` helper (src-tauri/src/pty/launch.rs); Hermes
// never types it into a terminal. So only agents whose catalog entry takes
// a first prompt can be handed a task.
//
// Everything here is pure and unit-tested; the dialog and SessionContext
// do the I/O.

import { getAgent, type AgentEntry } from "../catalog/agentCatalog";
import { slugify } from "../state/isolation";
import type { GitFile, GitProjectStatus } from "../types/git";
import type { SessionData } from "../types/session";

export type HandoffKind = "continue" | "duplicate";

/** How many changed files the seed lists by name before summarising. */
export const SEED_FILE_LIMIT = 40;

export interface HandoffSeedInput {
  readonly kind: HandoffKind;
  /** What the session is working on, in the user's words. */
  readonly task: string;
  /** True when that agent stopped on its usage limit. */
  readonly limited: boolean;
  /** Branch of the checkout the new agent starts in, when known. */
  readonly branch: string | null;
  /** Continue only: the files changed in that checkout so far. */
  readonly changedFiles: readonly ChangedFile[];
  /** Duplicate only: the branch the other agent keeps working on. */
  readonly parentBranch?: string | null;
}

export interface ChangedFile {
  readonly path: string;
  /** "modified", "added", "deleted", "renamed", "untracked"... */
  readonly status: string;
}

const STATUS_WORD: Record<string, string> = {
  modified: "modified",
  added: "new",
  untracked: "new",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  conflicted: "conflicted",
};

/** One line per file, files listed once (staged and unstaged merge). */
export function changedFilesOf(projects: readonly GitProjectStatus[]): ChangedFile[] {
  const seen = new Map<string, ChangedFile>();
  const multi = projects.filter((p) => p.is_git_repo).length > 1;
  for (const p of projects) {
    if (!p.is_git_repo) continue;
    for (const f of p.files as readonly GitFile[]) {
      const path = multi ? `${p.project_name}/${f.path}` : f.path;
      if (!seen.has(path)) seen.set(path, { path, status: f.status });
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The first prompt of the new agent. Plain text, English (it is read by
 * the agent, not shown as UI), no user-facing formatting. It names no agent
 * product: the new agent echoes its prompt to the terminal, and the
 * terminal's agent detection would take a product name there for the
 * agent that is running.
 */
export function buildHandoffSeed(input: HandoffSeedInput): string {
  const task = input.task.trim() || "(no task description was given; ask what to do)";
  const lines: string[] = [];
  if (input.kind === "continue") {
    lines.push(
      `You are taking over a task that another coding agent was working on in this same folder` +
        (input.limited ? `, until it hit its usage limit.` : `.`),
    );
    lines.push("", "Task:", task, "");
    const files = input.changedFiles;
    if (files.length === 0) {
      lines.push(`Files changed so far${input.branch ? ` on branch ${input.branch}` : ""}: none yet.`);
    } else {
      lines.push(`Files changed so far${input.branch ? ` on branch ${input.branch}` : ""}:`);
      for (const f of files.slice(0, SEED_FILE_LIMIT)) lines.push(`- ${STATUS_WORD[f.status] ?? f.status}: ${f.path}`);
      if (files.length > SEED_FILE_LIMIT) lines.push(`- and ${files.length - SEED_FILE_LIMIT} more (see git status)`);
    }
    lines.push(
      "",
      "Look at that work first (git status, git diff, git log), keep what is right, and finish the task.",
    );
  } else {
    lines.push(
      `Work on this task. Another coding agent is working on the same task` +
        (input.parentBranch ? ` on branch ${input.parentBranch}` : "") +
        `; you have your own copy${input.branch ? ` on branch ${input.branch}` : ""}, so work independently.`,
    );
    lines.push("", "Task:", task);
  }
  return lines.join("\n");
}

/**
 * The child branch for "Duplicate to another agent": the parent's branch,
 * `--`, the agent id; made unique against existing branches (`-2`, ...).
 */
export function childBranchName(parentBranch: string, agentId: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = `${parentBranch}--${slugify(agentId) || "agent"}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type HandoffTargetState = "ready" | "not_installed" | "no_prompt";

export interface HandoffTarget {
  readonly agent: AgentEntry;
  readonly state: HandoffTargetState;
}

/**
 * The agents a task can be handed to: every catalog agent this build shows
 * except the one already on it, each marked ready, not installed, or unable
 * to take a first prompt (the seed could only be typed, which Hermes never
 * does). Ready ones first, catalog order otherwise.
 */
export function handoffTargets(
  agents: readonly AgentEntry[],
  fromAgentId: string | null,
  installed: Readonly<Record<string, boolean>>,
): HandoffTarget[] {
  const out = agents
    .filter((a) => !a.custom && a.id !== fromAgentId)
    .map((agent): HandoffTarget => {
      if (!agent.terminal.initial_prompt) return { agent, state: "no_prompt" };
      if (installed[agent.id] !== true) return { agent, state: "not_installed" };
      return { agent, state: "ready" };
    });
  const rank = (t: HandoffTarget) => (t.state === "ready" ? 0 : 1);
  return out.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
}

/**
 * Whether a session can be continued or duplicated in another agent: a
 * live local session that runs an agent (a plain shell has no task to hand
 * over; a remote one cannot start a local agent in its folder).
 */
export function canHandOff(session: Pick<SessionData, "phase" | "ssh_info" | "ai_provider">): boolean {
  return session.phase !== "destroyed" && !session.ssh_info && !!session.ai_provider;
}

/** The task a handoff dialog starts with: the session's description, else its name. */
export function defaultTask(session: Pick<SessionData, "label" | "description">): string {
  return session.description?.trim() || session.label.trim();
}

/** Label of the new session: "<old label> · <agent name>". */
export function handoffLabel(parentLabel: string, agentId: string): string {
  const name = getAgent(agentId)?.name ?? agentId;
  return `${parentLabel.trim() || "Task"} · ${name}`;
}

/**
 * The session list order with every handed-off session right under the
 * session it came from (when that one is in the same list). Stable
 * otherwise; chains nest in order.
 */
export function nestUnderParents<T extends { id: string; parent_session_id?: string | null }>(list: readonly T[]): T[] {
  const ids = new Set(list.map((s) => s.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of list) {
    const parent = s.parent_session_id;
    if (parent && parent !== s.id && ids.has(parent)) {
      const arr = children.get(parent) ?? [];
      arr.push(s);
      children.set(parent, arr);
    } else {
      roots.push(s);
    }
  }
  const out: T[] = [];
  const visit = (s: T, seen: Set<string>) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
    for (const c of children.get(s.id) ?? []) visit(c, seen);
  };
  const seen = new Set<string>();
  for (const r of roots) visit(r, seen);
  // A cycle (a → b → a) has no root; keep those sessions rather than drop them.
  for (const s of list) if (!seen.has(s.id)) visit(s, seen);
  return out;
}
