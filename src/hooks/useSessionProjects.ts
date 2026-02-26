import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSessionProjects, attachSessionProject, detachSessionProject } from "../api/projects";

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

    listen<Project[]>(`session-realms-updated-${sessionId}`, (event) => {
      if (!cancelled) setProjects(event.payload);
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });

    // Listen for global project updates (scan completions)
    listen<Project>("realm-updated", () => {
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
