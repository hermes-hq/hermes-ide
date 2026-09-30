// ─── The launcher's unsent draft ───────────────────────────────────────
//
// A click outside the launcher closes it but keeps what was typed and
// chosen: ⌘N brings the same draft back. Cancel (Esc), a launch or an app
// restart forget it. Kept in memory only.

import type { LaunchChoice } from "../agent/capabilities/types";

export interface LauncherDraft {
  task: string;
  choice: LaunchChoice;
  repoPath: string;
  branch: string;
  branchEdited: boolean;
  checks: string[];
  checksEdited: boolean;
  expanded: boolean;
}

let draft: LauncherDraft | null = null;

export function saveLauncherDraft(next: LauncherDraft): void {
  draft = next;
}

export function takeLauncherDraft(): LauncherDraft | null {
  return draft;
}

export function clearLauncherDraft(): void {
  draft = null;
}

// "Save as preset?" offered by a launch that closed the sheet: asked when
// the launcher opens next. `count`: how many times it was launched.
export interface PendingSuggestion {
  choice: LaunchChoice;
  name: string;
  count: number;
}

let pendingSuggestion: PendingSuggestion | null = null;

export function setPendingSuggestion(next: PendingSuggestion | null): void {
  pendingSuggestion = next;
}

export function takePendingSuggestion(): PendingSuggestion | null {
  const s = pendingSuggestion;
  pendingSuggestion = null;
  return s;
}
