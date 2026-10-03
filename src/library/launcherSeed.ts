// ─── "Start a task with this": the Library hands the launcher its start ─
//
// The Library sets a seed and asks the app to open a fresh launcher; the
// launcher takes the seed once, when it mounts.

import type { LibraryLaunchPersona, LibraryLaunchPick } from "./delivery";

export interface LauncherLibrarySeed {
  /** The rendered prompt (the task text), or "" for a persona alone. */
  task: string;
  prompt?: LibraryLaunchPick | null;
  persona?: LibraryLaunchPersona | null;
}

let seed: LauncherLibrarySeed | null = null;

export function setLauncherSeed(next: LauncherLibrarySeed | null): void {
  seed = next;
}

/** The pending seed, once (the next call returns null). */
export function takeLauncherSeed(): LauncherLibrarySeed | null {
  const s = seed;
  seed = null;
  return s;
}
