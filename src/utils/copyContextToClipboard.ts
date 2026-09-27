import type { SessionData } from "../types/session";
import type { ContextState } from "../types/context";
import { formatContextMarkdown } from "../hooks/useContextState";
import { getContextPins } from "../api/context";
import { assembleSessionContext } from "../api/projects";
import { getAllMemory } from "../api/memory";

/**
 * Standalone utility for copying the full context bundle to clipboard.
 * Used by App.tsx for the Cmd+Shift+C keyboard shortcut — no React hooks needed.
 */
export async function copyContextToClipboard(
  session: SessionData | null,
  version: number = 0,
): Promise<void> {
  if (!session) return;

  const [pinsResult, projectsResult, memoryResult] = await Promise.allSettled([
    getContextPins(session.id, null),
    assembleSessionContext(session.id, 4000),
    getAllMemory("global", "global"),
  ]);

  const pins = pinsResult.status === "fulfilled" ? pinsResult.value : [];
  const projectCtx = projectsResult.status === "fulfilled" ? projectsResult.value : { projects: [] };
  const persistedMemory = memoryResult.status === "fulfilled" ? memoryResult.value : [];

  const ctx: ContextState = {
    pinnedItems: pins,
    memoryFacts: session.metrics.memory_facts,
    persistedMemory,
    projects: projectCtx.projects,
    workspacePaths: session.workspace_paths,
    workingDirectory: session.working_directory,
    agent: session.detected_agent?.name ?? null,
    model: session.detected_agent?.model ?? null,
  };

  const text = formatContextMarkdown(ctx, version);
  if (text) {
    await navigator.clipboard.writeText(text);
  }
}
