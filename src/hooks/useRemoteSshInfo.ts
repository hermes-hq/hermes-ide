import { useState, useEffect, useRef } from "react";
import { sshGetRemoteCwd, sshGetRemoteGitInfo } from "../api/sessions";

export interface RemoteSshInfo {
  cwd: string | null;
  branch: string | null;
  changeCount: number;
  isLoading: boolean;
}

const EMPTY: RemoteSshInfo = { cwd: null, branch: null, changeCount: 0, isLoading: false };

/**
 * Polls remote CWD and git info for SSH sessions.
 * Returns branch + changeCount compatible with useSessionGitSummary's shape.
 */
export function useRemoteSshInfo(
  sessionId: string | null,
  enabled: boolean = true,
): RemoteSshInfo {
  const [info, setInfo] = useState<RemoteSshInfo>({ ...EMPTY, isLoading: true });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!sessionId || !enabled) {
      setInfo(EMPTY);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const cwd = await sshGetRemoteCwd(sessionId);
        if (cancelled || !mountedRef.current) return;

        let branch: string | null = null;
        let changeCount = 0;

        if (cwd) {
          try {
            const git = await sshGetRemoteGitInfo(sessionId, cwd);
            if (!cancelled && mountedRef.current) {
              branch = git.branch;
              changeCount = git.change_count;
            }
          } catch {
            // Not a git repo or command failed — that's fine
          }
        }

        if (!cancelled && mountedRef.current) {
          setInfo({ cwd, branch, changeCount, isLoading: false });
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setInfo((prev) => ({ ...prev, isLoading: false }));
        }
      }
    };

    poll();
    const interval = setInterval(poll, 8000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId, enabled]);

  return info;
}
