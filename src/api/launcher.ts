import { invoke } from "@tauri-apps/api/core";

/** What the task launcher needs to know about a folder (src-tauri/src/task_launcher.rs). */
export interface RepoProbe {
  /** The repository's main checkout, or null when the folder is not in one. */
  git_root: string | null;
  branch_exists: boolean;
  local_branches: string[];
  /** `.hermes/worktree.toml`, when the repository has one. */
  worktree_toml: string | null;
  /** The branch checked out in the main checkout (null when detached). */
  current_branch: string | null;
  /** Something is at the path (after "~" is read as the home folder). */
  exists?: boolean;
  /** What is at the path is a folder. */
  is_dir?: boolean;
  /** The repository has at least one commit (a new worktree needs one to start from). */
  has_commits?: boolean;
  /** The path as it was read: trimmed, "~" expanded. */
  resolved?: string;
}

/**
 * Keeps a task's checks (the launcher's "Checks") in the git folder of the
 * task's worktree (`<git-dir>/hermes/done-when.json`), never in the
 * repository itself; `hi check` reads them there. Returns the file's path.
 */
export function writeTaskDoneWhen(checkout: string, commands: string[]): Promise<string> {
  return invoke<string>("task_write_done_when", { checkout, commands });
}

export function probeTaskRepo(path: string, branch?: string): Promise<RepoProbe> {
  return invoke<RepoProbe>("task_repo_probe", { path, branch: branch ?? null });
}

/** Writes `<checkout>/.hermes/features/<slug>/feature.md` unless it exists; returns its path. */
export function writeTaskFeatureFile(checkout: string, slug: string, contents: string): Promise<string> {
  return invoke<string>("task_write_feature_file", { checkout, slug, contents });
}

/**
 * The first prompt of a task tracked as a feature: the task, the track's
 * rules and the first phase's instructions (the repository's
 * .hermes/phases/, else Hermes's own), ending at the first gate.
 */
export function taskTrackPrompt(repoRoot: string, slug: string, task: string): Promise<string> {
  return invoke<string>("task_track_prompt", { repoRoot, slug, task });
}
