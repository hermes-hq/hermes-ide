import { useState, useEffect, useRef, useCallback } from "react";
import { gitStatus } from "../api/git";
import type { GitSessionStatus } from "../types/git";

export function useGitStatus(
  sessionId: string | null,
  enabled: boolean,
  pollInterval: number = 3000,
) {
  const [status, setStatus] = useState<GitSessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const fetchStatus = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const result = await gitStatus(id);
      if (!mounted.current) return;
      // Discard result if session changed while fetching
      if (sessionIdRef.current !== id) return;
      setStatus(result);
      setError(null);
    } catch (err) {
      if (mounted.current && sessionIdRef.current === id) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  // Clear stale state when sessionId changes
  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled || !sessionId) return;

    fetchStatus();
    const interval = setInterval(fetchStatus, pollInterval);

    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [enabled, sessionId, pollInterval, fetchStatus]);

  return { status, error, refresh: fetchStatus };
}
