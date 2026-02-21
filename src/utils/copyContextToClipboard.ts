import type { SessionData } from "../types/session";
import type { ContextState } from "../types/context";
import { formatContextMarkdown } from "../hooks/useContextState";
import { getContextPins } from "../api/context";
import { getErrorResolutions } from "../api/context";
import { assembleSessionContext } from "../api/realms";
import { getAllMemory } from "../api/memory";

/**
 * Standalone utility for copying the full context bundle to clipboard.
 * Used by App.tsx for the Cmd+Shift+C keyboard shortcut — no React hooks needed.
 */
export async function copyContextToClipboard(
  session: SessionData | null,
  version: number = 0,
  executionMode: string = "manual",
): Promise<void> {
  if (!session) return;

  const [pinsResult, errorsResult, realmsResult, memoryResult] = await Promise.allSettled([
    getContextPins(session.id, null),
    getErrorResolutions(session.working_directory, 10),
    assembleSessionContext(session.id, 4000),
    getAllMemory("global", "global"),
  ]);

  const pins = pinsResult.status === "fulfilled" ? pinsResult.value : [];
  const rawErrors = errorsResult.status === "fulfilled" ? errorsResult.value : [];
  const errorResolutions = rawErrors
    .filter((p) => p.resolution)
    .map((p) => ({ fingerprint: p.fingerprint, resolution: p.resolution!, occurrence_count: p.occurrence_count }));
  const realmCtx = realmsResult.status === "fulfilled" ? realmsResult.value : { realms: [] };
  const persistedMemory = memoryResult.status === "fulfilled" ? memoryResult.value : [];

  const ctx: ContextState = {
    pinnedItems: pins,
    memoryFacts: session.metrics.memory_facts,
    persistedMemory,
    realms: realmCtx.realms,
    workspacePaths: session.workspace_paths,
    workingDirectory: session.working_directory,
    agent: session.detected_agent?.name ?? null,
    model: session.detected_agent?.model ?? null,
    errorResolutions,
    filesTouched: session.metrics.files_touched,
    recentErrors: session.metrics.recent_errors,
  };

  const text = formatContextMarkdown(ctx, version, executionMode);
  if (text) {
    await navigator.clipboard.writeText(text);
  }
}
