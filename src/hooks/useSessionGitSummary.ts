import { useState, useEffect, useRef, useCallback } from "react";
import { subscribeGitStatus, getGitStatusSnapshot } from "./useGitStatusCache";

export interface ProjectBranchSummary {
  projectName: string;
  branch: string;
  changeCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
}

export interface SessionGitSummary {
  branch: string | null;
  changeCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  isLoading: boolean;
  /** All git project branches for multi-project sessions */
  allBranches: ProjectBranchSummary[];
}

const EMPTY: SessionGitSummary = {
  branch: null,
  changeCount: 0,
  ahead: 0,
  behind: 0,
  hasConflicts: false,
  isLoading: false,
  allBranches: [],
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
    const gitProjects = snapshot.projects.filter((p) => p.is_git_repo && p.branch);
    if (gitProjects.length === 0) {
      setSummary(EMPTY);
      return;
    }
    const first = gitProjects[0];
    const allBranches: ProjectBranchSummary[] = gitProjects.map((p) => ({
      projectName: p.project_name,
      branch: p.branch!,
      changeCount: p.files.length,
      ahead: p.ahead,
      behind: p.behind,
      hasConflicts: p.has_conflicts,
    }));
    setSummary({
      branch: first.branch,
      changeCount: first.files.length,
      ahead: first.ahead,
      behind: first.behind,
      hasConflicts: first.has_conflicts,
      isLoading: false,
      allBranches,
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
