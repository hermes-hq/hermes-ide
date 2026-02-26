import { useState, useEffect, useRef, useCallback } from "react";
import { listProcesses } from "../api/processes";
import type { ProcessSnapshot } from "../types/process";

const POLL_INTERVAL = 2000;
const HIGHLIGHT_DURATION = 1000;

export function useProcesses(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPids, setNewPids] = useState<Set<number>>(new Set());
  const [removedPids, setRemovedPids] = useState<Set<number>>(new Set());
  const prevPids = useRef<Set<number>>(new Set());
  const mounted = useRef(true);
  const highlightTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const fetchProcesses = useCallback(async () => {
    try {
      const snap = await listProcesses();
      if (!mounted.current) return;

      const currentPids = new Set(snap.processes.map((p) => p.pid));

      // Compute diffs
      const added = new Set<number>();
      const removed = new Set<number>();

      if (prevPids.current.size > 0) {
        for (const pid of currentPids) {
          if (!prevPids.current.has(pid)) added.add(pid);
        }
        for (const pid of prevPids.current) {
          if (!currentPids.has(pid)) removed.add(pid);
        }
      }

      prevPids.current = currentPids;
      setSnapshot(snap);
      setError(null);

      if (added.size > 0) {
        setNewPids(added);
        const t = setTimeout(() => { if (mounted.current) setNewPids(new Set()); }, HIGHLIGHT_DURATION);
        highlightTimers.current.push(t);
      }
      if (removed.size > 0) {
        setRemovedPids(removed);
        const t = setTimeout(() => { if (mounted.current) setRemovedPids(new Set()); }, HIGHLIGHT_DURATION);
        highlightTimers.current.push(t);
      }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;

    // Immediate first fetch
    fetchProcesses();

    const interval = setInterval(fetchProcesses, POLL_INTERVAL);

    return () => {
      mounted.current = false;
      clearInterval(interval);
      // Clear all pending highlight timers to prevent state updates after cleanup
      highlightTimers.current.forEach(clearTimeout);
      highlightTimers.current = [];
    };
  }, [enabled, fetchProcesses]);

  return { snapshot, error, newPids, removedPids };
}
