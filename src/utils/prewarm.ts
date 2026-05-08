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
  // Live wins when it's a real array.  When live arrives, it's the
  // canonical list — static entries that aren't in live are stale.
  if (Array.isArray(liveServers)) return [...liveServers];
  return asArray(staticServers);
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
