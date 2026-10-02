// ─── Land sheet: what the sheet says and drafts ──────────────────────
//
// Pure functions, so the wording and the decisions are table-tested:
// - which feature.md belongs to the task, and its Done-When commands;
// - the Done-When state shown on the sheet (and whether Land is demoted
//   to "Land anyway");
// - the commit message drafted from the plan or the task (one draft, used
//   by the Land sheet and the Review Desk);
// - the pull request body (turns, plan, Done-When, totals).
//
// Every sentence people read goes through `translate` (land.* keys).

import type { Diffstat } from "../agent/contract/turns";
import type { AgentStatus } from "../agent/contract/status";
import { parseFeatureFrontMatter, type FeatureMeta } from "../agent/contract/featureFrontMatter";
import { parseWorktreeToml } from "../agent/contract/worktreeToml";
import { translate } from "../i18n/registry";
import { getSetting } from "../api/settings";
import { parseTaskLaunches } from "../launcher/taskLauncher";
import type { FeatureFile, GhStatus, LandPreview, MergeCheck } from "./api";
import type { LandTurn } from "./turnSource";

export interface TaskFeature {
  readonly meta: FeatureMeta;
  readonly body: string;
}

/** The branch name without Hermes's `hermes/` prefix (or any folder). */
export function branchStem(branch: string): string {
  if (branch.startsWith("hermes/")) return branch.slice("hermes/".length);
  const parts = branch.split("/");
  return parts[parts.length - 1] ?? branch;
}

/** The feature.md whose slug is the task branch's (`hermes/<slug>`). */
export function pickFeature(files: readonly FeatureFile[], branch: string): TaskFeature | null {
  const stem = branchStem(branch);
  for (const f of files) {
    const parsed = parseFeatureFrontMatter(f.text);
    if (parsed.ok && parsed.meta.slug === stem) return { meta: parsed.meta, body: parsed.body };
  }
  return null;
}

/** Done-When commands: the feature's, else the worktree recipe's. */
export function doneWhenCommands(feature: TaskFeature | null, worktreeToml: string | null): readonly string[] {
  if (feature && feature.meta.doneWhen.length > 0) return feature.meta.doneWhen;
  if (!worktreeToml) return [];
  const parsed = parseWorktreeToml(worktreeToml);
  return parsed.ok ? parsed.config.doneWhen : [];
}

export type DoneWhenState =
  | { readonly kind: "none" }
  | { readonly kind: "not_run"; readonly commands: readonly string[] }
  | { readonly kind: "failing"; readonly commands: readonly string[]; readonly detail: string };

/**
 * What the sheet says about Done-When. A session whose status is
 * `check_failed` (raised by the check runner, F27) is failing; configured
 * checks with no failure reported are "not run" here, never "passing".
 */
export function doneWhenState(commands: readonly string[], status: AgentStatus): DoneWhenState {
  if (status.kind === "check_failed") return { kind: "failing", commands, detail: status.detail };
  if (commands.length === 0) return { kind: "none" };
  return { kind: "not_run", commands };
}

export function doneWhenLabel(state: DoneWhenState): string {
  switch (state.kind) {
    case "none":
      return translate("land.doneWhenNone");
    case "not_run":
      return translate(state.commands.length === 1 ? "land.doneWhenNotRunOne" : "land.doneWhenNotRun", { count: state.commands.length });
    case "failing":
      return state.detail ? translate("land.doneWhenFailingDetail", { detail: state.detail }) : translate("land.doneWhenFailing");
  }
}

export function diffstatText(d: Diffstat): string {
  return `${d.files} file${d.files === 1 ? "" : "s"}, +${d.insertions} -${d.deletions}`;
}

function humanize(stem: string): string {
  const words = stem.replace(/[-_]+/g, " ").trim();
  if (!words) return "";
  return words[0].toUpperCase() + words.slice(1);
}

/** The first `# heading` of a markdown body. */
function firstHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = /^#{1,3}\s+(.+?)\s*#*$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/** Longest subject line drafted (git's own advice). */
export const SUBJECT_MAX = 72;

/** The first non-empty line of `text`, at most SUBJECT_MAX characters (cut at a word). */
export function firstLineSubject(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line.length <= SUBJECT_MAX) return line;
  const cut = line.slice(0, SUBJECT_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface DraftInput {
  readonly branch: string;
  readonly label: string;
  readonly turns: readonly LandTurn[];
  readonly feature: TaskFeature | null;
  readonly diffstat: Diffstat;
  /** The task as it was typed in the launcher (its launch record), when known. */
  readonly task?: string | null;
  /** Done-When commands to name in the body. */
  readonly doneWhen?: readonly string[];
}

/** Subject line: the plan's title, else the task's first line, else the branch name, else the session. */
export function draftSubject(input: DraftInput): string {
  if (input.feature) {
    return firstHeading(input.feature.body) ?? humanize(input.feature.meta.slug);
  }
  const task = input.task?.trim();
  if (task) return firstLineSubject(task);
  const fromBranch = humanize(branchStem(input.branch));
  if (fromBranch && !/^[0-9a-f]{7,}$/i.test(branchStem(input.branch))) return fromBranch;
  return input.label.trim() || "Land task";
}

const MAX_FILES_PER_TURN = 6;

export function turnLine(t: LandTurn): string {
  const shown = t.files.slice(0, MAX_FILES_PER_TURN).join(", ");
  const more = t.files.length > MAX_FILES_PER_TURN ? `, +${t.files.length - MAX_FILES_PER_TURN} more` : "";
  return `Turn ${t.turn.n}: ${diffstatText(t.turn.diffstat)}${shown ? ` (${shown}${more})` : ""}`;
}

/**
 * Commit message: the subject; then the task (when the subject is not all
 * of it) and the Done-When commands. The turn list belongs to the pull
 * request body, not to the commit.
 */
export function draftMessage(input: DraftInput): string {
  const subject = draftSubject(input);
  const body: string[] = [];
  const task = input.task?.trim() ?? "";
  if (task && task !== subject) body.push(task);
  const checks = input.doneWhen ?? [];
  if (checks.length > 0) body.push(`Done-When: ${checks.join("; ")}`);
  if (body.length === 0 && !task && !input.feature) body.push(`Changes: ${diffstatText(input.diffstat)}`);
  return body.length > 0 ? `${subject}\n\n${body.join("\n\n")}` : subject;
}

/** The task typed for `sessionId` in the launcher (its launch record), or null. */
export async function launchedTask(sessionId: string): Promise<{ task: string; doneWhen: string[] } | null> {
  try {
    const raw = await getSetting("task_launches");
    const rec = parseTaskLaunches(raw).find((r) => r.sessionId === sessionId);
    return rec ? { task: rec.task, doneWhen: rec.doneWhen ?? [] } : null;
  } catch {
    return null;
  }
}

const MAX_PLAN_CHARS = 6000;

/** Pull request body: turns, the plan when a feature exists, Done-When, totals. */
export function draftPrBody(input: DraftInput, doneWhen: readonly string[]): string {
  const out: string[] = [];
  const task = input.task?.trim();
  if (task) out.push(task, "");
  out.push("## Turns", "");
  if (input.turns.length > 0) for (const t of input.turns) out.push(`- ${turnLine(t)}`);
  else out.push("No turns were recorded for this session.");
  if (input.feature) {
    const plan = input.feature.body.trim();
    out.push("", "## Plan", "", plan.length > MAX_PLAN_CHARS ? `${plan.slice(0, MAX_PLAN_CHARS)}\n\n(plan shortened)` : plan);
  }
  if (doneWhen.length > 0) {
    out.push("", "## Done-When", "");
    for (const c of doneWhen) out.push(`- \`${c}\``);
  }
  out.push("", `**Changes:** ${diffstatText(input.diffstat)}`);
  return out.join("\n");
}

/** Why an option can't be chosen, or null when it can. */
export interface LandAvailability {
  readonly commit: string | null;
  readonly pr: string | null;
  readonly merge: string | null;
  readonly archive: string | null;
}

/**
 * The option the sheet picks by itself: a pull request when it can open
 * one; otherwise, once the GitHub CLI status is known, a local merge, then
 * a commit. Null while it cannot tell yet (or nothing can be used).
 */
export function defaultLandMode(available: LandAvailability, gh: GhStatus | null): "pr" | "merge" | "commit" | null {
  if (!available.pr) return "pr";
  if (gh && !available.merge) return "merge";
  if (gh && !available.commit) return "commit";
  return null;
}

/** Why a pull request cannot be opened, or null when it can. */
function prBlocked(p: LandPreview, gh: GhStatus | null, base: string | null, hasWork: boolean): string | null {
  if (!base) return translate("land.prNoBase");
  if (!hasWork) return translate("land.prNothing");
  // No remote: that is the only thing to say (not also "sign in to gh").
  if (!p.remote) return translate("land.prNoRemote");
  if (!gh) return translate("land.prCheckingGh");
  if (gh.state === "not_github") return translate("land.prNotGithub");
  if (gh.state === "missing") return translate("land.prGhMissing");
  if (gh.state === "signed_out") return translate("land.prGhSignedOut");
  return null;
}

export function landAvailability(p: LandPreview, gh: GhStatus | null): LandAvailability {
  const hasWork = p.uncommittedFiles > 0 || p.commitsAhead > 0;
  const base = p.base?.name ?? null;
  return {
    commit: p.uncommittedFiles > 0 ? null : translate("land.commitNothing"),
    pr: prBlocked(p, gh, base, hasWork),
    merge: mergeBlocked(p.merge, base),
    archive: p.shared
      ? translate("land.archiveShared")
      : p.uncommittedFiles > 0
        ? translate("land.archiveUncommitted")
        : null,
  };
}

/** "a.md", "a.md and b.md", "a.md, b.md and 2 more". */
function fileList(files: readonly string[]): string {
  if (files.length <= 1) return files[0] ?? "";
  if (files.length === 2) return `${files[0]}, ${files[1]}`;
  return `${files[0]}, ${files[1]} (+${files.length - 2})`;
}

function mergeBlocked(merge: MergeCheck, base: string | null): string | null {
  switch (merge.kind) {
    case "no_base":
      return translate("land.mergeNoBase");
    case "nothing_to_merge":
      return translate("land.mergeNothing", { base: base ?? translate("land.theBase") });
    case "conflict":
      return translate("land.mergeConflict", { base: base ?? translate("land.theBase"), files: merge.files.join(", ") });
    case "dirty_base":
      // Never "stash": say which file is in the way, where.
      return translate(merge.files.length === 1 ? "land.mergeDirtyBaseOne" : "land.mergeDirtyBase", {
        files: fileList(merge.files),
        base: base ?? translate("land.theBase"),
      });
    default:
      return null;
  }
}

export function mergeNote(merge: MergeCheck, base: string | null): string {
  switch (merge.kind) {
    case "fast_forward":
      return translate("land.mergeFastForward", { base: base ?? "" });
    case "clean":
      return translate("land.mergeClean", { base: base ?? "" });
    default:
      return mergeBlocked(merge, base) ?? "";
  }
}

/** Branch names Hermes treats as a project's main line. */
const MAIN_LINE = new Set(["main", "master", "trunk"]);

/**
 * Landing goes to the branch the task was started from, else the one the
 * project folder has checked out. When that is the folder's and not a main
 * line, say so: the person may expect main.
 */
export function baseBranchNote(base: string | null, recordedBase: string | null = null): string | null {
  if (!base || MAIN_LINE.has(base) || base === recordedBase) return null;
  return translate("land.baseNote", { base });
}

/**
 * Landing into another branch than the one the task was started from
 * brings that branch's own commits along: say how many.
 */
export function baseMismatchNote(mismatch: { recorded: string; commits: number } | null | undefined, chosen: string | null): string | null {
  if (!mismatch || !chosen || mismatch.recorded === chosen) return null;
  return translate(mismatch.commits === 1 ? "land.baseMismatchOne" : "land.baseMismatch", {
    recorded: mismatch.recorded,
    other: chosen,
    count: mismatch.commits,
  });
}

/** The one line offered to the agent after a conflict (pasted, never sent). */
export function rebaseRequest(base: string, files: readonly string[]): string {
  return `Please rebase this branch onto ${base} and resolve the conflicts in ${files.join(", ")}.`;
}

/** The one line offered to the agent for a failing check (pasted, never sent). */
export function ciLogRequest(check: string, relativePath: string): string {
  return `CI check "${check}" failed on the pull request. The failing log is in ${relativePath}; please fix it.`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
