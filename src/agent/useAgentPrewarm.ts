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
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PrewarmMcpServer } from "../utils/prewarm";

export interface PrewarmData {
  mcpServers: PrewarmMcpServer[];
  slashCommands: string[];
  memoryPaths: string[];
}

const EMPTY: PrewarmData = { mcpServers: [], slashCommands: [], memoryPaths: [] };

export function useAgentPrewarm(cwd: string | null | undefined): PrewarmData {
  const [data, setData] = useState<PrewarmData>(EMPTY);

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
  }, [cwd]);

  return data;
}
