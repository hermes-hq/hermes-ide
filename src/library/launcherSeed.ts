// ─── "Start a task with this": the Library hands the launcher its start ─
//
// The Library sets a seed and asks the app to open a fresh launcher; the
// launcher reads the seed when it renders and clears it once it is on
// screen. Reading is not taking: React may throw a first render away (a
// render interrupted, a part of the tree not loaded yet) and render the
// sheet again, which must still find the seed.

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

/** The pending seed, left in place. */
export function peekLauncherSeed(): LauncherLibrarySeed | null {
  return seed;
}

/** The launcher that read `taken` is on screen: that seed is used up (a newer one stays). */
export function clearLauncherSeed(taken: LauncherLibrarySeed): void {
  if (seed === taken) seed = null;
}
