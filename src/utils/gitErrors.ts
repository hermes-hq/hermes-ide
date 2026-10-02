// ─── Structured git errors from the backend ──────────────────────────
//
// Some refusals come back as a prefix and a JSON object, so the UI can
// offer the right choice instead of showing git's own text:
//   HOOK_REFUSED:{"hook","output"}        a commit hook said no (git/safety.rs)
//   BRANCH_UNMERGED:{"branch","base","commits"}  deleting would lose commits

export const HOOK_REFUSED_PREFIX = "HOOK_REFUSED:";
export const BRANCH_UNMERGED_PREFIX = "BRANCH_UNMERGED:";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
}

function parsePrefixed(err: unknown, prefix: string): Record<string, unknown> | null {
  const text = errorText(err);
  const at = text.indexOf(prefix);
  if (at < 0) return null;
  try {
    const v = JSON.parse(text.slice(at + prefix.length)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface HookRefusal {
  /** pre-commit, commit-msg, prepare-commit-msg, or "a git hook". */
  hook: string;
  /** What the hook printed. */
  output: string;
}

export function parseHookRefusal(err: unknown): HookRefusal | null {
  const v = parsePrefixed(err, HOOK_REFUSED_PREFIX);
  if (!v || typeof v.hook !== "string") return null;
  return { hook: v.hook, output: typeof v.output === "string" ? v.output : "" };
}

export interface UnmergedBranch {
  branch: string;
  base: string;
  commits: number;
}

export function parseUnmergedBranch(err: unknown): UnmergedBranch | null {
  const v = parsePrefixed(err, BRANCH_UNMERGED_PREFIX);
  if (!v || typeof v.branch !== "string" || typeof v.base !== "string") return null;
  return { branch: v.branch, base: v.base, commits: typeof v.commits === "number" ? v.commits : 1 };
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b:?\s*/gi;

/**
 * A git error as a sentence for people: libgit2's "; class=…; code=…"
 * details and ids (project or session UUIDs) dropped, "Error: " prefixes
 * removed, and `projectNames` (id → name) used where an id names a project.
 */
export function plainGitError(err: unknown, projectNames: Record<string, string> = {}): string {
  let text = errorText(err).trim();
  for (const [id, name] of Object.entries(projectNames)) {
    if (id && name) text = text.split(id).join(name);
  }
  text = text
    .replace(/;?\s*class=\w+ \(-?\d+\)/g, "")
    .replace(/;?\s*code=\w+ \(-?\d+\)/g, "")
    .replace(UUID, "")
    .replace(/^(Error|fatal|error):\s*/i, "")
    .trim();
  // "demo: demo has no commits yet" → "demo has no commits yet"
  const m = /^([^:]{1,80}): (.*)$/s.exec(text);
  if (m && m[2].startsWith(`${m[1]} `)) text = m[2];
  return text;
}
