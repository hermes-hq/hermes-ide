import { useState, useEffect, useRef, useCallback } from "react";
import { subscribeGitStatus, getGitStatusSnapshot } from "./useGitStatusCache";

export interface SessionGitSummary {
  branch: string | null;
  changeCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  isLoading: boolean;
}

const EMPTY: SessionGitSummary = {
  branch: null,
  changeCount: 0,
  ahead: 0,
  behind: 0,
  hasConflicts: false,
  isLoading: false,
};

/**
 * Lightweight hook that provides git summary data (branch + change count)
 * for a given session. Uses a shared polling cache so sessions with the
 * same working directory share a single poller instead of each polling
 * independently.
 */
export function useSessionGitSummary(
  sessionId: string | null,
  enabled: boolean = true,
  workingDirectory?: string,
): SessionGitSummary {
  const [summary, setSummary] = useState<SessionGitSummary>({ ...EMPTY, isLoading: true });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const derive = useCallback((workDir: string) => {
    const snapshot = getGitStatusSnapshot(workDir);
    if (!snapshot) return;
    if (!mountedRef.current) return;
    const gitProject = snapshot.projects.find((p) => p.is_git_repo);
    if (!gitProject) {
      setSummary(EMPTY);
      return;
    }
    setSummary({
      branch: gitProject.branch,
      changeCount: gitProject.files.length,
      ahead: gitProject.ahead,
      behind: gitProject.behind,
      hasConflicts: gitProject.has_conflicts,
      isLoading: false,
    });
  }, []);

  useEffect(() => {
    if (!sessionId || !enabled || !workingDirectory) {
      setSummary(!sessionId || !enabled ? EMPTY : { ...EMPTY, isLoading: true });
      return;
    }

    const unsubscribe = subscribeGitStatus(workingDirectory, sessionId, () => {
      derive(workingDirectory);
    });

    // Derive immediately in case cache already has data
    derive(workingDirectory);

    return unsubscribe;
  }, [sessionId, enabled, workingDirectory, derive]);

  return summary;
}
