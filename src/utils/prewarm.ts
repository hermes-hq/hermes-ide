/**
 * Agent prewarm — merge helpers.  Spec: docs/internal/v1-tui-parity-plan.md §8.12.
 *
 * The static prewarm reads `~/.claude.json` and `.claude/commands/*.md`
 * directly from disk so the UI is populated the moment the session is
 * created.  Once the SDK's `init` event arrives, the live data replaces
 * the static (init is authoritative).  These pure helpers pin the
 * "prefer init when defined, fall back to static otherwise" contract.
 *
 * **Defensive shape handling**: production init events sometimes
 * include `null` or unexpected shapes for these fields (older Claude
 * builds, malformed payloads, plugin wrappers).  Every helper checks
 * `Array.isArray` before spreading so a bad `live` value falls back
 * cleanly to static rather than crashing the render.
 */

export interface PrewarmMcpServer {
  name: string;
  status: string;
}

function asArray<T>(v: readonly T[] | null | undefined | unknown): T[] {
  return Array.isArray(v) ? [...(v as T[])] : [];
}

export function mergeMcpServers(
  staticServers: readonly PrewarmMcpServer[],
  liveServers: readonly PrewarmMcpServer[] | undefined,
): PrewarmMcpServer[] {
  // Until live arrives, the static list is all we have.
  if (!Array.isArray(liveServers)) return asArray(staticServers);

  // Otherwise UNION: live entries win on shape (status from the SDK),
  // and any static-only entries are appended.  Static-only happens
  // when the user has just added a server to `~/.claude.json` but
  // the bridge is still running on an older `--resume` that restored
  // its prior MCP list — the new entry is on disk but not in init
  // yet.  Without this union, freshly-added servers wouldn't appear
  // in the panel until a brand-new session spawn.
  const out = [...liveServers];
  const seen = new Set(out.map((s) => s.name));
  for (const s of asArray<PrewarmMcpServer>(staticServers)) {
    if (!seen.has(s.name)) out.push(s);
  }
  return out;
}

export function mergeSlashCommands(
  staticCommands: readonly string[],
  liveCommands: readonly string[] | undefined,
): string[] {
  if (Array.isArray(liveCommands)) return [...liveCommands];
  return asArray(staticCommands);
}

export function mergeMemoryPaths(
  staticPaths: readonly string[],
  livePaths: readonly string[] | undefined,
): string[] {
  if (Array.isArray(livePaths)) return [...livePaths];
  return asArray(staticPaths);
}
