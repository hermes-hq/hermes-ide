import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getSessionProjects,
  attachSessionProject,
  detachSessionProject,
  getProjects,
} from "../api/projects";
import { addWorkspacePath, removeWorkspacePath } from "../api/sessions";

export type { Project } from "../types/project";

import type { Project } from "../types/project";

export function useSessionProjects(sessionId: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);

  // Fetch projects for active session
  useEffect(() => {
    if (!sessionId) {
      setProjects([]);
      return;
    }

    // Listen for updates to this session's projects
    let cancelled = false;

    getSessionProjects(sessionId)
      .then((r) => { if (!cancelled) setProjects(r); })
      .catch(() => { if (!cancelled) setProjects([]); });
    let unlisten: (() => void) | null = null;
    let unlistenGlobal: (() => void) | null = null;

    listen<Project[]>(`session-projects-updated-${sessionId}`, (event) => {
      if (!cancelled) setProjects(event.payload);
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });

    // Listen for global project updates (scan completions)
    listen<Project>("project-updated", () => {
      if (cancelled) return;
      // Refetch to get updated data
      getSessionProjects(sessionId)
        .then((r) => { if (!cancelled) setProjects(r); })
        .catch((err) => console.warn("[useSessionProjects] Failed to refresh projects:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlistenGlobal = u; }
    });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenGlobal?.();
    };
  }, [sessionId]);

  const attach = useCallback(async (projectId: string) => {
    if (!sessionId) return;
    await attachSessionProject(sessionId, projectId, "primary");

    // Look up the project's path and ALSO add it to the session's
    // workspace_paths so the agent runtime sees it.  attach_session_project
    // alone only writes a DB relationship row — it never propagates the
    // path to session state, so without this the agent has no idea you
    // attached anything.  This is the visible bug "I attached a folder
    // but Claude didn't know about it" the user kept hitting.
    try {
      const all = await getProjects();
      const proj = all.find((p) => p.id === projectId);
      if (proj?.path) {
        await addWorkspacePath(sessionId, proj.path);
      }
    } catch (err) {
      console.warn("[useSessionProjects] Failed to add workspace_path on attach:", err);
    }

    // Re-fetch to ensure UI stays consistent even if the backend event is delayed
    try {
      const updated = await getSessionProjects(sessionId);
      setProjects(updated);
    } catch (err) {
      console.warn("[useSessionProjects] Failed to refresh after attach:", err);
    }
  }, [sessionId]);

  const detach = useCallback(async (projectId: string) => {
    if (!sessionId) return;
    // Mirror the attach side: drop the path from workspace_paths so the
    // next respawn omits the corresponding `--add-dir`.
    try {
      const all = await getProjects();
      const proj = all.find((p) => p.id === projectId);
      if (proj?.path) {
        await removeWorkspacePath(sessionId, proj.path);
      }
    } catch (err) {
      console.warn("[useSessionProjects] Failed to remove workspace_path on detach:", err);
    }
    await detachSessionProject(sessionId, projectId);
    // Re-fetch to ensure UI stays consistent even if the backend event is delayed
    try {
      const updated = await getSessionProjects(sessionId);
      setProjects(updated);
    } catch (err) {
      console.warn("[useSessionProjects] Failed to refresh after detach:", err);
    }
  }, [sessionId]);

  return { projects, attach, detach };
}
