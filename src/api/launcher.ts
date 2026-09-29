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
}

export function probeTaskRepo(path: string, branch?: string): Promise<RepoProbe> {
  return invoke<RepoProbe>("task_repo_probe", { path, branch: branch ?? null });
}

/** Writes `<checkout>/.hermes/features/<slug>/feature.md` unless it exists; returns its path. */
export function writeTaskFeatureFile(checkout: string, slug: string, contents: string): Promise<string> {
  return invoke<string>("task_write_feature_file", { checkout, slug, contents });
}
