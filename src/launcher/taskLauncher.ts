// ─── Task launcher (F15) — the decisions, free of React ─────────────────
//
// ⌘N opens one sheet: the task, the agent, the repository, an automatic
// hermes/<slug> branch, the "done when" check from .hermes/worktree.toml and
// the track size. Everything the sheet decides lives here so it is unit
// tested directly:
//
//   - the branch and the session label a task gets;
//   - which blocking rows stop Launch (agent signed out or missing, branch
//     exists, not a git repository, low disk);
//   - the first feature.md of a Full-track task (ADR 004 §6);
//   - the per-session record of what was launched (the `task_launches`
//     setting), kept for the features that come later (Done-When, Land).

import { parseWorktreeToml } from "../agent/contract/worktreeToml";
import { isFeatureSlug, type FeatureTrack } from "../agent/contract/featureFrontMatter";
import { getAgent } from "../catalog/agentCatalog";
import { slugify } from "../state/isolation";
import type { DoctorRow } from "../api/doctor";
import { findBranchClash, type BranchClash } from "../utils/branchClash";

export type TaskTrack = FeatureTrack;
export const TASK_TRACKS: readonly TaskTrack[] = ["Quick", "Light", "Full"];

/** Settings key holding the launch records (see TaskLaunchRecord). */
export const TASK_LAUNCHES_KEY = "task_launches";
/** Records kept; the oldest go first. */
export const MAX_TASK_LAUNCHES = 200;

/** Words of the task that make up its branch name. */
const SLUG_WORDS = 6;

/**
 * Branch-name slug for a task: its first few words, e.g. "Fix the flaky
 * login test on CI" → "fix-the-flaky-login-test-on". Empty when the task has
 * no letters or digits at all.
 */
export function taskSlug(task: string): string {
  const words = task.trim().split(/\s+/).slice(0, SLUG_WORDS).join(" ");
  const slug = slugify(words, 40);
  return isFeatureSlug(slug) ? slug : "";
}

/** The branch a task gets: hermes/<slug>, or hermes/task when it has no slug. */
export function taskBranch(task: string): string {
  return `hermes/${taskSlug(task) || "task"}`;
}

/** The branch of the same task on a second agent: <branch>-<agent>. */
export function secondAgentBranch(branch: string, agentId: string): string {
  const suffix = slugify(agentId, 20) || "second";
  return `${branch}-${suffix}`;
}

/** hermes/fix-login → hermes/fix-login-2, -3, ... (the first free one). */
export function nextFreeBranch(branch: string, taken: (b: string) => boolean, limit = 50): string {
  for (let n = 2; n < limit; n++) {
    const candidate = `${branch}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${branch}-${Date.now().toString(36)}`;
}

/** A branch name the user may type: git's rules, loosely (no spaces, no "..", no leading "-"). */
export function isUsableBranchName(branch: string): boolean {
  const b = branch.trim();
  if (!b || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".lock") || b.endsWith(".")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(b)) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{")) return false;
  return true;
}

/** The session's name: the task's first line, cut to fit the sidebar. */
export function taskLabel(task: string, max = 48): string {
  const first = task.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (first.length <= max) return first;
  return first.slice(0, max - 1).trimEnd() + "…";
}

/**
 * The "done when" commands from .hermes/worktree.toml, or [] when there is
 * no file, no key, or the file cannot be read (the reason is in `error`).
 */
export function doneWhenFromToml(text: string | null | undefined): { commands: string[]; error: string | null } {
  if (!text) return { commands: [], error: null };
  const parsed = parseWorktreeToml(text);
  if (!parsed.ok) return { commands: [], error: `line ${parsed.line}: ${parsed.error}` };
  return { commands: [...parsed.config.doneWhen], error: null };
}

/** Whether an agent can take the task on its launch line (catalog `initial_prompt`). */
export function agentTakesFirstPrompt(agentId: string): boolean {
  return !!getAgent(agentId)?.terminal.initial_prompt;
}

// ─── Blocking rows ─────────────────────────────────────────────────────

export type BlockingRow =
  | { kind: "not-installed"; agentId: string }
  | { kind: "signed-out"; agentId: string }
  | { kind: "no-repo" }
  | { kind: "not-git"; path: string }
  /**
   * The branch to create is taken: by a branch of that exact name, or by one
   * whose name (or folder) differs only in letter case, which macOS and
   * Windows treat as the same (`existing` is that branch's name).
   */
  | { kind: "branch-exists"; branch: string; suggestion: string; existing: string; clash: BranchClash["kind"] }
  | { kind: "bad-branch"; branch: string }
  | { kind: "low-disk"; freeBytes: number; requiredBytes: number };

export interface LaunchCheckInput {
  /** The agents the task runs on (the second agent, when one is chosen, too). */
  agents: readonly { id: string; branch: string }[];
  /** Doctor rows by agent id; an agent with no row yet is not judged. */
  doctor: Readonly<Record<string, DoctorRow | undefined>>;
  repoPath: string;
  /** null while the repository is still being checked. */
  gitRoot: string | null | undefined;
  /** The local branches of the repository. */
  branches: readonly string[];
  disk: { freeBytes: number | null; requiredBytes: number; belowThreshold: boolean } | null;
}

/**
 * The rows that stop Launch, in the order they are shown. The repository
 * comes first (nothing else can be judged without it), then each agent,
 * then each branch, then the disk.
 */
export function blockingRows(input: LaunchCheckInput): BlockingRow[] {
  const rows: BlockingRow[] = [];
  const repo = input.repoPath.trim();
  if (!repo) rows.push({ kind: "no-repo" });
  else if (input.gitRoot === null) rows.push({ kind: "not-git", path: repo });
  for (const { id } of input.agents) {
    const row = input.doctor[id];
    if (!row) continue;
    if (!row.installed) rows.push({ kind: "not-installed", agentId: id });
    else if (row.signed_in === "no") rows.push({ kind: "signed-out", agentId: id });
  }
  if (repo && input.gitRoot) {
    for (const { branch } of input.agents) {
      if (!isUsableBranchName(branch)) {
        rows.push({ kind: "bad-branch", branch });
      } else {
        const clash = findBranchClash(branch, input.branches);
        if (clash) {
          const taken = (b: string) => findBranchClash(b, input.branches) !== null;
          rows.push({ kind: "branch-exists", branch, suggestion: nextFreeBranch(branch, taken), existing: clash.existing, clash: clash.kind });
        }
      }
    }
  }
  if (input.disk?.belowThreshold && input.disk.freeBytes !== null) {
    rows.push({ kind: "low-disk", freeBytes: input.disk.freeBytes, requiredBytes: input.disk.requiredBytes });
  }
  return rows;
}

/** Launch is possible with a task, a checked repository and no blocking row. */
export function canLaunch(task: string, gitRoot: string | null | undefined, rows: readonly BlockingRow[]): boolean {
  return task.trim().length > 0 && !!gitRoot && rows.length === 0;
}

/** "12.3 GB", in decimal units like the disk guard's "10 GB". */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

// ─── Full track: the first feature.md ─────────────────────────────────

function yamlScalar(value: string): string {
  const v = value.replace(/[\r\n]+/g, " ").trim();
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return v;
}

/**
 * The first `.hermes/features/<slug>/feature.md` of a Full-track task: the
 * front matter F28 reads (phase questions, no gate yet) and the task as the
 * body.
 */
export function featureMarkdown(opts: { slug: string; task: string; doneWhen: readonly string[] }): string {
  const lines = ["---", `slug: ${opts.slug}`, "track: Full", "phase: questions", "gate: none"];
  if (opts.doneWhen.length === 0) lines.push("done_when: []");
  else {
    lines.push("done_when:");
    for (const cmd of opts.doneWhen) lines.push(`  - ${yamlScalar(cmd)}`);
  }
  lines.push("---", "", opts.task.trim(), "");
  return lines.join("\n");
}

// ─── Launch records ──────────────────────────────────────────────────

export interface TaskLaunchRecord {
  sessionId: string;
  task: string;
  agentId: string;
  mode: "terminal" | "agent";
  repo: string;
  branch: string;
  track: TaskTrack;
  doneWhen: string[];
  /** The session started for the same task on a second agent, if any. */
  pairedWith: string | null;
  createdAt: number;
}

export function parseTaskLaunches(raw: string | null | undefined): TaskLaunchRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (r): r is TaskLaunchRecord =>
      !!r &&
      typeof r === "object" &&
      typeof (r as TaskLaunchRecord).sessionId === "string" &&
      typeof (r as TaskLaunchRecord).task === "string" &&
      TASK_TRACKS.includes((r as TaskLaunchRecord).track),
  );
}

/** Adds records, newest last, keeping at most MAX_TASK_LAUNCHES. */
export function appendTaskLaunches(existing: readonly TaskLaunchRecord[], added: readonly TaskLaunchRecord[]): TaskLaunchRecord[] {
  const ids = new Set(added.map((r) => r.sessionId));
  return [...existing.filter((r) => !ids.has(r.sessionId)), ...added].slice(-MAX_TASK_LAUNCHES);
}

// ─── Defaults ───────────────────────────────────────────────────────────

/**
 * The agent the launcher preselects: the one used last, when it is still
 * installed; else the first installed one in catalog order; else the one
 * used last or the first in the catalog (its row then says it is missing).
 */
export function pickDefaultAgent(
  lastUsed: string | null,
  agentIds: readonly string[],
  doctor: Readonly<Record<string, DoctorRow | undefined>>,
): string | null {
  const installed = (id: string) => doctor[id]?.installed === true;
  if (lastUsed && agentIds.includes(lastUsed) && installed(lastUsed)) return lastUsed;
  const firstInstalled = agentIds.find(installed);
  if (firstInstalled) return firstInstalled;
  if (lastUsed && agentIds.includes(lastUsed)) return lastUsed;
  return agentIds[0] ?? null;
}
