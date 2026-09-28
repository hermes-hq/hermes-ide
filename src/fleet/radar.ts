// ─── Collision Radar v0 (F37) ─────────────────────────────────────────
//
// Two sessions whose latest turns touched the same file in the same
// repository are about to collide at merge time. The turn ledger (F20)
// records what every turn changed; this compares the latest turns of every
// session and names the overlap. Git-only, any agent. Predicting real merge
// conflicts between branches comes later.

/** How many of a session's latest turns count as "latest". */
export const RADAR_TURN_WINDOW = 3;

function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  // git quotes paths with unusual bytes C-style; keep it simple and safe.
  return p.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/**
 * The repository-relative paths a unified diff changes: both sides of a
 * rename, never /dev/null. Reads the `diff --git` headers and falls back to
 * `---`/`+++` lines for a plain diff.
 */
export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  // Only a file's header (before its first hunk) names files: inside a
  // hunk, a removed line "-- x" reads as "--- x".
  let inHeader = true;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      // `diff --git a/x b/x` (a path with spaces is read from the lines below).
      const git = /^diff --git (?:"a\/(.+?)"|a\/(\S+)) (?:"b\/(.+?)"|b\/(\S+))$/.exec(line);
      if (git) {
        const a = git[1] ?? git[2];
        const b = git[3] ?? git[4];
        if (a) files.add(unquoteGitPath(a));
        if (b) files.add(unquoteGitPath(b));
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    if (!inHeader) continue;
    const rename = /^rename (?:from|to) (.+)$/.exec(line);
    if (rename) {
      files.add(unquoteGitPath(rename[1]));
      continue;
    }
    const side = /^(?:---|\+\+\+) (?:"?[ab]\/)?(.+?)"?(?:\t.*)?$/.exec(line);
    if (side && side[1] !== "/dev/null" && side[1] !== "dev/null") files.add(side[1]);
  }
  return [...files];
}

export interface RadarEntry {
  readonly sessionId: string;
  /** Repositories the session works in (project ids, or its folder). */
  readonly repoKeys: readonly string[];
  /** Files its latest turns touched. */
  readonly files: ReadonlySet<string>;
}

export interface OverlapWith {
  readonly sessionId: string;
  /** Shared files, sorted. */
  readonly files: readonly string[];
}

export interface SessionOverlap {
  readonly sessionId: string;
  readonly others: readonly OverlapWith[];
}

/** Pure: every session whose latest files meet another session's in a shared repository. */
export function computeOverlaps(entries: readonly RadarEntry[]): Map<string, SessionOverlap> {
  const out = new Map<string, OverlapWith[]>();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.sessionId === b.sessionId) continue;
      if (!a.repoKeys.some((k) => b.repoKeys.includes(k))) continue;
      const shared = [...a.files].filter((f) => b.files.has(f)).sort();
      if (shared.length === 0) continue;
      (out.get(a.sessionId) ?? out.set(a.sessionId, []).get(a.sessionId)!).push({ sessionId: b.sessionId, files: shared });
      (out.get(b.sessionId) ?? out.set(b.sessionId, []).get(b.sessionId)!).push({ sessionId: a.sessionId, files: shared });
    }
  }
  const result = new Map<string, SessionOverlap>();
  for (const [sessionId, others] of out) result.set(sessionId, { sessionId, others });
  return result;
}
