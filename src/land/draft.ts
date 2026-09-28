// ─── Land sheet: what the sheet says and drafts ──────────────────────
//
// Pure functions, so the wording and the decisions are table-tested:
// - which feature.md belongs to the task, and its Done-When commands;
// - the Done-When state shown on the sheet (and whether Land is demoted
//   to "Land anyway");
// - the commit message drafted from the turns or the plan;
// - the pull request body (turns, plan, Done-When, totals).

import type { Diffstat } from "../agent/contract/turns";
import type { AgentStatus } from "../agent/contract/status";
import { parseFeatureFrontMatter, type FeatureMeta } from "../agent/contract/featureFrontMatter";
import { parseWorktreeToml } from "../agent/contract/worktreeToml";
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
      return "No Done-When checks";
    case "not_run":
      return `${state.commands.length} check${state.commands.length === 1 ? "" : "s"}, no result yet`;
    case "failing":
      return state.detail ? `Failing: ${state.detail}` : "Failing";
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

export interface DraftInput {
  readonly branch: string;
  readonly label: string;
  readonly turns: readonly LandTurn[];
  readonly feature: TaskFeature | null;
  readonly diffstat: Diffstat;
}

/** Subject line: the plan's title, else the branch name, else the session. */
export function draftSubject(input: DraftInput): string {
  if (input.feature) {
    return firstHeading(input.feature.body) ?? humanize(input.feature.meta.slug);
  }
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

/** Commit message: subject, then the turns (or the totals when none were recorded). */
export function draftMessage(input: DraftInput): string {
  const lines = [draftSubject(input), ""];
  if (input.turns.length > 0) {
    lines.push(`${input.turns.length} turn${input.turns.length === 1 ? "" : "s"}:`);
    for (const t of input.turns) lines.push(`- ${turnLine(t)}`);
  } else {
    lines.push(`Changes: ${diffstatText(input.diffstat)}`);
  }
  return lines.join("\n");
}

const MAX_PLAN_CHARS = 6000;

/** Pull request body: turns, the plan when a feature exists, Done-When, totals. */
export function draftPrBody(input: DraftInput, doneWhen: readonly string[]): string {
  const out: string[] = ["## Turns", ""];
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

export function landAvailability(p: LandPreview, gh: GhStatus | null): LandAvailability {
  const hasWork = p.uncommittedFiles > 0 || p.commitsAhead > 0;
  const base = p.base?.name ?? null;
  let pr: string | null = null;
  if (!base) pr = "There is no base branch to open a pull request against.";
  else if (!hasWork) pr = "Nothing on this branch to open a pull request for.";
  else if (!p.remote) pr = "This repository has no remote to push to.";
  else if (!gh) pr = "Checking GitHub CLI…";
  else if (gh.state === "missing") pr = "GitHub CLI (gh) is not installed.";
  else if (gh.state === "signed_out") pr = "GitHub CLI (gh) is not signed in.";
  return {
    commit: p.uncommittedFiles > 0 ? null : "No uncommitted changes to commit.",
    pr,
    merge: mergeBlocked(p.merge, base),
    archive: p.shared
      ? "Another session works in this checkout."
      : p.uncommittedFiles > 0
        ? "Uncommitted changes would be lost; land them first."
        : null,
  };
}

function mergeBlocked(merge: MergeCheck, base: string | null): string | null {
  switch (merge.kind) {
    case "no_base":
      return "There is no base branch to merge into.";
    case "nothing_to_merge":
      return `${base ?? "The base"} already has everything on this branch.`;
    case "conflict":
      return `Merging into ${base ?? "the base"} would conflict in ${merge.files.join(", ")}.`;
    default:
      return null;
  }
}

export function mergeNote(merge: MergeCheck, base: string | null): string {
  switch (merge.kind) {
    case "fast_forward":
      return `${base} has not moved: the merge is a fast-forward.`;
    case "clean":
      return `${base} moved on; merging is clean.`;
    default:
      return mergeBlocked(merge, base) ?? "";
  }
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
