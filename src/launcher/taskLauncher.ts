// ─── Task launcher (F15) — the decisions, free of React ─────────────────
//
// ⌘N opens one sheet: the task, the agent, the repository, an automatic
// hermes/<slug> branch, the "done when" check from .hermes/worktree.toml and
// the track size. Everything the sheet decides lives here so it is unit
// tested directly:
//
//   - the branch and the session label a task gets;
//   - which blocking rows stop Launch (agent signed out or missing, branch
//     exists, no folder at the path, low disk). A folder that is not a git
//     repository never blocks: the agent works directly in it;
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

/** Letters a plain accent strip would lose or mangle, spelled the way their language writes them without the mark. */
const TRANSLITERATE: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", Ä: "Ae", Ö: "Oe", Ü: "Ue", ẞ: "SS" };

/**
 * Branch-name slug for a task: its first few words, e.g. "Fix the flaky
 * login test on CI" → "fix-the-flaky-login-test-on". German umlauts and ß
 * are spelled out ("Größe prüfen" → "groesse-pruefen"). Empty when the task
 * has no letters or digits at all.
 */
export function taskSlug(task: string): string {
  const words = task
    .trim()
    .split(/\s+/)
    .slice(0, SLUG_WORDS)
    .join(" ")
    .replace(/[äöüßÄÖÜẞ]/g, (c) => TRANSLITERATE[c] ?? c);
  const slug = slugify(words, 40);
  return isFeatureSlug(slug) ? slug : "";
}

/**
 * The branch a task gets: hermes/<slug>. A task with no letters or digits
 * to name it (emoji, a script slugify cannot spell) gets hermes/task-<id>,
 * `id` being a short id the sheet keeps for its lifetime; without one,
 * hermes/task.
 */
export function taskBranch(task: string, fallbackId?: string): string {
  const slug = taskSlug(task);
  if (slug) return `hermes/${slug}`;
  return fallbackId ? `hermes/task-${fallbackId}` : "hermes/task";
}

/** Six hex digits, for the branch of a task with nothing in it to name it after. */
export function shortTaskId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}

/**
 * The branch the launcher makes up for a task: hermes/<slug>, or the first
 * free hermes/<slug>-2, -3… when that one is taken (letter case included,
 * see findBranchClash). The person never has to name a branch to run the
 * same task twice.
 */
export function autoTaskBranch(task: string, branches: readonly string[], fallbackId?: string): string {
  const base = taskBranch(task, fallbackId);
  const taken = (b: string) => findBranchClash(b, branches) !== null || branchNameProblem(b, branches) !== null;
  if (!taken(base)) return base;
  // A folder spelled in another letter case (`Hermes/…`) is that folder: its spelling is kept.
  const free = freeBranchFor(base, branches);
  if (free && !taken(free)) return free;
  return nextFreeBranch(base, taken);
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

/**
 * A free branch to offer instead of `branch`, which collides with one of
 * `branches` (see findBranchClash), or null when none is found. When the
 * clash is a folder that differs only in letter case (`Feature/new` next to
 * `feature/inbox`), no `-2` suffix frees it: the folders are spelled as the
 * existing branch spells them first (`feature/new`).
 */
export function freeBranchFor(branch: string, branches: readonly string[]): string | null {
  const taken = (b: string) => findBranchClash(b, branches) !== null;
  let base = branch;
  for (let i = 0; i < 8; i++) {
    const clash = findBranchClash(base, branches);
    if (!clash || clash.kind === "same") break;
    const respelled = respellFolders(base, clash.existing);
    if (respelled === base) break;
    base = respelled;
  }
  if (!taken(base)) return base;
  const next = nextFreeBranch(base, taken);
  return taken(next) ? null : next;
}

/** `name` with its folders spelled as `other` spells the same ones (letter case only). */
function respellFolders(name: string, other: string): string {
  const parts = name.split("/");
  const otherParts = other.split("/");
  const folders = Math.min(parts.length, otherParts.length) - 1;
  for (let i = 0; i < folders; i++) {
    if (parts[i] === otherParts[i]) continue;
    if (parts[i].toLowerCase() !== otherParts[i].toLowerCase()) break;
    parts[i] = otherParts[i];
  }
  return parts.join("/");
}

/** A branch name the user may type: git's rules, loosely (no spaces, no "..", no leading "-"). */
export function isUsableBranchName(branch: string): boolean {
  const b = branch.trim();
  if (!b || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".lock") || b.endsWith(".")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(b)) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{")) return false;
  return true;
}

/** Longest branch name the launcher accepts: its worktree folder is named after it, and file names stop at 255 bytes. */
export const MAX_BRANCH_LENGTH = 200;

/**
 * Why git (or the file system under the worktree) would refuse a branch
 * name that passes isUsableBranchName, or null:
 *   - "folder": the name is a folder of existing branches (`release` next to `release/2.3`);
 *   - "under-branch": a folder of the name is an existing branch (`feature/inbox/sub` next to `feature/inbox`);
 *   - "dot-part": a part starts with "." (`hermes/.wip`);
 *   - "lock-part": a part ends with ".lock";
 *   - "too-long": longer than MAX_BRANCH_LENGTH.
 * Folders compare without letter case (macOS and Windows keep one folder).
 */
export type BranchNameProblem =
  | { kind: "folder"; existing: string }
  | { kind: "under-branch"; existing: string }
  | { kind: "dot-part" }
  | { kind: "lock-part" }
  | { kind: "too-long"; max: number };

export function branchNameProblem(branch: string, branches: readonly string[]): BranchNameProblem | null {
  const b = branch.trim();
  if (!b) return null;
  const parts = b.split("/");
  if (parts.some((p) => p.startsWith("."))) return { kind: "dot-part" };
  if (parts.some((p) => p.toLowerCase().endsWith(".lock"))) return { kind: "lock-part" };
  if (b.length > MAX_BRANCH_LENGTH) return { kind: "too-long", max: MAX_BRANCH_LENGTH };
  const lower = b.toLowerCase();
  for (const other of branches) {
    const o = other.toLowerCase();
    if (o.startsWith(`${lower}/`)) return { kind: "folder", existing: other };
    if (lower.startsWith(`${o}/`)) return { kind: "under-branch", existing: other };
  }
  return null;
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
  /**
   * The agent cannot run signed out. `accountId`: an account Hermes added
   * (not the CLI's default profile) is the one signed out.
   */
  | { kind: "signed-out"; agentId: string; accountId?: string }
  | { kind: "no-repo" }
  /**
   * Nothing to work in at the path: `missing`, nothing there; `file`, a file,
   * not a folder. (A folder that is not a git repository is fine.)
   */
  | { kind: "not-git"; path: string; missing: "missing" | "file" }
  /** The repository has no commit yet: a new worktree has nothing to start from. */
  | { kind: "no-commits" }
  /**
   * The branch to create is taken: by a branch of that exact name, or by one
   * whose name (or folder) differs only in letter case, which macOS and
   * Windows treat as the same (`existing` is that branch's name).
   */
  | { kind: "branch-exists"; branch: string; suggestion: string | null; existing: string; clash: BranchClash["kind"] }
  /** `problem`: why git would refuse a name that looks fine (see branchNameProblem). */
  | { kind: "bad-branch"; branch: string; problem?: BranchNameProblem }
  | { kind: "low-disk"; freeBytes: number; requiredBytes: number };

export interface LaunchCheckAgent {
  id: string;
  /** The branch to create ("" when the agent creates none). */
  branch: string;
  /** The account the agent runs on; the CLI's own profile when absent or "default". */
  accountId?: string | null;
  /**
   * Whether that account is signed in, as the capability backend says
   * (undefined: not known yet). Only an added account is judged by it: the
   * doctor checks the default profile.
   */
  accountSignedIn?: boolean;
}

export interface LaunchCheckInput {
  /** The agents the task runs on (the second agent, when one is chosen, too). */
  agents: readonly LaunchCheckAgent[];
  /** Doctor rows by agent id; an agent with no row yet is not judged. */
  doctor: Readonly<Record<string, DoctorRow | undefined>>;
  repoPath: string;
  /** null while the repository is still being checked. */
  gitRoot: string | null | undefined;
  /** The local branches of the repository. */
  branches: readonly string[];
  disk: { freeBytes: number | null; requiredBytes: number; belowThreshold: boolean } | null;
  /** What the probe saw at the path (absent: not known, nothing is said). */
  folder?: { exists: boolean; isDir: boolean; hasCommits: boolean } | null;
}

/** An added account (not the CLI's default profile). */
export function isAddedAccount(accountId: string | null | undefined): accountId is string {
  return !!accountId && accountId !== "default";
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
  else if (input.gitRoot === null) {
    // A plain folder (or one holding several repositories) is a place to
    // work too: no worktree, no branch, the agent works in it directly.
    const missing = input.folder && !input.folder.exists ? "missing" : input.folder && !input.folder.isDir ? "file" : undefined;
    if (missing) rows.push({ kind: "not-git", path: repo, missing });
  } else if (input.gitRoot && input.folder && !input.folder.hasCommits && input.agents.length > 0) {
    // (The agents given here are the ones that create a branch.)
    rows.push({ kind: "no-commits" });
  }
  for (const { id, accountId, accountSignedIn } of input.agents) {
    const row = input.doctor[id];
    if (!row) continue;
    if (!row.installed) rows.push({ kind: "not-installed", agentId: id });
    // The doctor speaks for the CLI's default profile only; an account
    // Hermes added has its own sign-in state.
    else if (isAddedAccount(accountId)) {
      if (accountSignedIn === false) rows.push({ kind: "signed-out", agentId: id, accountId });
    } else if (row.signed_in === "no") rows.push({ kind: "signed-out", agentId: id });
  }
  if (repo && input.gitRoot) {
    for (const { branch } of input.agents) {
      const problem = isUsableBranchName(branch) ? branchNameProblem(branch, input.branches) : null;
      if (!isUsableBranchName(branch)) {
        rows.push({ kind: "bad-branch", branch });
      } else if (problem) {
        rows.push({ kind: "bad-branch", branch, problem });
      } else {
        const clash = findBranchClash(branch, input.branches);
        if (clash) {
          rows.push({ kind: "branch-exists", branch, suggestion: freeBranchFor(branch, input.branches), existing: clash.existing, clash: clash.kind });
        }
      }
    }
  }
  if (input.disk?.belowThreshold && input.disk.freeBytes !== null) {
    rows.push({ kind: "low-disk", freeBytes: input.disk.freeBytes, requiredBytes: input.disk.requiredBytes });
  }
  return rows;
}

/**
 * Where a launch runs: the repository's main checkout, or the folder itself
 * when it is not in a git repository. undefined while the path is still
 * being checked; null when there is no folder there.
 */
export function launchRoot(
  gitRoot: string | null | undefined,
  folder: { exists: boolean; isDir: boolean } | null | undefined,
  resolved: string,
): string | null | undefined {
  if (gitRoot) return gitRoot;
  if (gitRoot === undefined) return undefined;
  return folder && folder.exists && folder.isDir && resolved.trim() ? resolved.trim() : null;
}

/** Launch is possible with a task, a checked folder (git or not) and no blocking row. */
export function canLaunch(task: string, root: string | null | undefined, rows: readonly BlockingRow[]): boolean {
  return task.trim().length > 0 && !!root && rows.length === 0;
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
  /**
   * One id per launch (both agents of an "Also on" share it), so a second
   * agent that started later from the task queue is paired with the first.
   */
  launchId?: string;
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

/**
 * Adds records, newest last, keeping at most MAX_TASK_LAUNCHES. Two records
 * of one launch (the same launchId: the task on two agents, one of which
 * may have waited in the queue) are paired with each other.
 */
export function appendTaskLaunches(existing: readonly TaskLaunchRecord[], added: readonly TaskLaunchRecord[]): TaskLaunchRecord[] {
  const ids = new Set(added.map((r) => r.sessionId));
  const all = [...existing.filter((r) => !ids.has(r.sessionId)), ...added].map((r) => ({ ...r }));
  for (const r of all) {
    if (!r.launchId || !ids.has(r.sessionId)) continue;
    const other = all.find((o) => o !== r && o.launchId === r.launchId);
    if (!other) continue;
    r.pairedWith = other.sessionId;
    other.pairedWith = r.sessionId;
  }
  return all.slice(-MAX_TASK_LAUNCHES);
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
