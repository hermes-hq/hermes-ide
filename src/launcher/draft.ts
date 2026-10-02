// ─── The launcher's unsent draft ───────────────────────────────────────
//
// However the launcher closes without launching — Esc, Cancel, a click
// outside, or because Settings, a sign-in or another overlay took its place
// — it keeps what was typed and chosen, and ⌘N (or the configuration
// closing) brings the same draft back. Only a launch or "Start over" forgets
// it. Kept in memory for the app session only.

import { comboKey } from "../agent/capabilities/choice";
import type { LaunchChoice } from "../agent/capabilities/types";
import type { SessionMode } from "../types/session";

export interface LauncherDraft {
  task: string;
  choice: LaunchChoice;
  repoPath: string;
  branch: string;
  branchEdited: boolean;
  checks: string[];
  checksEdited: boolean;
  expanded: boolean;
  /** Terminal or Agent view, when the agent offers both. */
  viewMode?: SessionMode;
}

/** Worth keeping: something was typed or chosen (an untouched sheet is not a draft). */
export function isDraftWorthKeeping(d: { task: string; touched: boolean; expanded: boolean; branchEdited: boolean; checksEdited: boolean; restored: boolean }): boolean {
  return d.restored || d.touched || d.expanded || d.branchEdited || d.checksEdited || d.task.trim() !== "";
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

// Combinations "Save as preset?" was offered for in this app session: asked
// once per session. Only "No, don't ask again" makes it never come back.
const offered = new Set<string>();

export function wasOfferedThisSession(choice: LaunchChoice): boolean {
  return offered.has(comboKey(choice));
}

export function markOfferedThisSession(choice: LaunchChoice): void {
  offered.add(comboKey(choice));
}

/** Test-only: forget the offers of this session. */
export function __resetOffersForTest(): void {
  offered.clear();
}

export function setPendingSuggestion(next: PendingSuggestion | null): void {
  pendingSuggestion = next;
}

export function takePendingSuggestion(): PendingSuggestion | null {
  const s = pendingSuggestion;
  pendingSuggestion = null;
  return s;
}
