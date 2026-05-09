/**
 * useAgentPrewarm — fetches the on-disk static data Hermes can show
 * BEFORE the SDK init event lands.  Spec: §8.12 of v1-tui-parity-plan.md.
 *
 * In stream-json mode the SDK only emits `init` after the first user
 * message; this hook reads `~/.claude.json`, `.claude/commands/*.md`,
 * and CLAUDE.md files directly via Rust IPCs, so the UI is populated
 * the moment the session is created.  Once init arrives, the live
 * data takes over (init is authoritative — see merge helpers in
 * `src/utils/prewarm.ts`).
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PrewarmMcpServer } from "../utils/prewarm";

export interface PrewarmData {
  mcpServers: PrewarmMcpServer[];
  slashCommands: string[];
  memoryPaths: string[];
  /** Force a fresh re-read of the static prewarm sources.  Use after
   *  a write that may have changed `~/.claude.json` (e.g. removing an
   *  MCP server) so the panel reflects the new on-disk state without
   *  waiting for the next session-context-panel mount. */
  refresh: () => void;
}

interface PrewarmRaw {
  mcpServers: PrewarmMcpServer[];
  slashCommands: string[];
  memoryPaths: string[];
}

const EMPTY_DATA: PrewarmRaw = { mcpServers: [], slashCommands: [], memoryPaths: [] };

export function useAgentPrewarm(cwd: string | null | undefined): PrewarmData {
  const [data, setData] = useState<PrewarmRaw>(EMPTY_DATA);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cwdArg = cwd ?? null;
    Promise.all([
      invoke<PrewarmMcpServer[]>("read_static_mcp_servers").catch(() => [] as PrewarmMcpServer[]),
      invoke<string[]>("read_static_slash_commands", { cwd: cwdArg }).catch(() => [] as string[]),
      invoke<string[]>("read_static_memory_paths", { cwd: cwdArg }).catch(() => [] as string[]),
    ]).then(([mcpServers, slashCommands, memoryPaths]) => {
      if (cancelled) return;
      setData({ mcpServers, slashCommands, memoryPaths });
    });
    return () => { cancelled = true; };
  }, [cwd, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { ...data, refresh };
}
