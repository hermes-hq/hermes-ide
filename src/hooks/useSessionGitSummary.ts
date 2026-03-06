import { useState, useEffect, useRef } from "react";
import { gitStatus } from "../api/git";

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

const POLL_INTERVAL = 5000;

/**
 * Lightweight hook that provides git summary data (branch + change count)
 * for a given session. Designed for session list display — polls slower
 * than the full Git panel (5s vs 3s).
 */
export function useSessionGitSummary(
  sessionId: string | null,
  enabled: boolean = true,
): SessionGitSummary {
  const [summary, setSummary] = useState<SessionGitSummary>({ ...EMPTY, isLoading: true });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!sessionId || !enabled) {
      setSummary(EMPTY);
      return;
    }

    let cancelled = false;

    const fetch = () => {
      gitStatus(sessionId)
        .then((status) => {
          if (cancelled || !mountedRef.current) return;
          // Find the first project that is a git repo
          const gitProject = status.projects.find((p) => p.is_git_repo);
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
        })
        .catch(() => {
          if (!cancelled && mountedRef.current) {
            setSummary((prev) => ({ ...prev, isLoading: false }));
          }
        });
    };

    fetch();
    const interval = setInterval(fetch, POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId, enabled]);

  return summary;
}
