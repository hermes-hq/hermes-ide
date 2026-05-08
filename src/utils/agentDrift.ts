/**
 * Compare two `--add-dir` lists order-insensitively.  Used by
 * `submitAgentMessage` and the SESSION_UPDATED reducer dedup so that an
 * upstream reorder of `workspace_paths` (DB sort change, dedup pass,
 * re-attach toggle) does not register as drift and trigger a spurious
 * subprocess respawn.
 *
 * The Claude Agent SDK's `additionalDirectories` is a set, not an
 * ordered list — `[A, B]` and `[B, A]` are identical to the SDK.  Mirror
 * that contract on our side so the React state and SDK state agree.
 */
export function hasAddDirDrift(prior: readonly string[], live: readonly string[]): boolean {
  if (prior.length !== live.length) return true;
  const pSorted = [...prior].sort();
  const lSorted = [...live].sort();
  for (let i = 0; i < pSorted.length; i++) {
    if (pSorted[i] !== lSorted[i]) return true;
  }
  return false;
}

/** Set-equality of two `--add-dir` lists.  Inverse of {@link hasAddDirDrift}. */
export function addDirsEqual(a: readonly string[], b: readonly string[]): boolean {
  return !hasAddDirDrift(a, b);
}
