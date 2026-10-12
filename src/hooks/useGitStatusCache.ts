/**
 * Module-level git status cache that deduplicates polling across sessions
 * sharing the same working directory.
 *
 * Instead of N sessions each polling gitStatus() every 5s, we poll once
 * per unique working_directory and share the result.
 */
import { gitStatus } from "../api/git";
import type { GitSessionStatus } from "../types/git";

const DEFAULT_POLL_INTERVAL = 5000;

interface CacheEntry {
  /** Any session ID that has this working directory (used for the IPC call) */
  sessionId: string;
  data: GitSessionStatus | null;
  /** Number of active subscribers */
  refCount: number;
  intervalId: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
  /** Current poll interval — shortest requested by any subscriber */
  pollInterval: number;
  /** All requested intervals so we can recompute on unsubscribe */
  requestedIntervals: Map<() => void, number>;
  /** A status call is pending; ticks skip until it settles */
  inFlight: boolean;
  /** A forced refresh arrived while a call was pending; run one more after it */
  again: boolean;
}

const cache = new Map<string, CacheEntry>();

const windowHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * One status walk per directory at a time, and no timed walks while the
 * window is hidden: on a big repo a walk can outlast the interval, and
 * overlapping walks of the same tree only make each other slower.
 * `force` (first subscriber, explicit refresh) runs even when hidden, and
 * queues one follow-up call instead of being dropped while one is pending.
 */
function fetchAndNotify(workDir: string, force = false) {
  const entry = cache.get(workDir);
  if (!entry) return;
  if (!force && windowHidden()) return;
  if (entry.inFlight) {
    if (force) entry.again = true;
    return;
  }
  entry.inFlight = true;
  gitStatus(entry.sessionId)
    .then((result) => {
      const current = cache.get(workDir);
      if (current !== entry) return;
      current.data = result;
      current.listeners.forEach((cb) => cb());
    })
    .catch(() => {
      // Silently ignore — previous data remains
    })
    .finally(() => {
      entry.inFlight = false;
      if (entry.again && cache.get(workDir) === entry) {
        entry.again = false;
        fetchAndNotify(workDir, true);
      }
    });
}

let visibilityAttached = false;

/** Catch up once when the window comes back instead of waiting a full interval. */
function attachVisibilityRefresh() {
  if (visibilityAttached || typeof document === "undefined") return;
  visibilityAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (windowHidden()) return;
    for (const workDir of cache.keys()) fetchAndNotify(workDir);
  });
}

function restartPolling(workDir: string, entry: CacheEntry) {
  if (entry.intervalId !== null) clearInterval(entry.intervalId);
  if (entry.pollInterval > 0) {
    entry.intervalId = setInterval(() => fetchAndNotify(workDir), entry.pollInterval);
  } else {
    entry.intervalId = null;
  }
}

function computeInterval(entry: CacheEntry): number {
  let min = DEFAULT_POLL_INTERVAL;
  for (const interval of entry.requestedIntervals.values()) {
    if (interval > 0 && interval < min) min = interval;
  }
  return min;
}

/**
 * Subscribe to git status updates for a working directory.
 * Returns an unsubscribe function.
 *
 * @param pollInterval - Desired poll interval in ms. The cache uses the
 *   shortest interval requested by any active subscriber.
 */
export function subscribeGitStatus(
  workDir: string,
  sessionId: string,
  onChange: () => void,
  pollInterval: number = DEFAULT_POLL_INTERVAL,
): () => void {
  let entry = cache.get(workDir);

  if (!entry) {
    entry = {
      sessionId,
      data: null,
      refCount: 0,
      intervalId: null,
      listeners: new Set(),
      pollInterval: DEFAULT_POLL_INTERVAL,
      requestedIntervals: new Map(),
      inFlight: false,
      again: false,
    };
    cache.set(workDir, entry);
    attachVisibilityRefresh();
  }

  // Update the sessionId — use the latest subscriber's session
  entry.sessionId = sessionId;
  entry.refCount++;
  entry.listeners.add(onChange);
  entry.requestedIntervals.set(onChange, pollInterval);

  // Recompute and restart polling if interval changed
  const newInterval = computeInterval(entry);
  const needsRestart = entry.refCount === 1 || newInterval !== entry.pollInterval;
  entry.pollInterval = newInterval;

  if (entry.refCount === 1) {
    fetchAndNotify(workDir, true);
  }
  if (needsRestart) {
    restartPolling(workDir, entry);
  }

  return () => {
    const e = cache.get(workDir);
    if (!e) return;
    e.refCount--;
    e.listeners.delete(onChange);
    e.requestedIntervals.delete(onChange);
    if (e.refCount <= 0) {
      if (e.intervalId !== null) clearInterval(e.intervalId);
      cache.delete(workDir);
    } else {
      // Recompute interval — a fast subscriber may have left
      const updated = computeInterval(e);
      if (updated !== e.pollInterval) {
        e.pollInterval = updated;
        restartPolling(workDir, e);
      }
    }
  };
}

export function getGitStatusSnapshot(workDir: string): GitSessionStatus | null {
  return cache.get(workDir)?.data ?? null;
}

/** Force an immediate refresh (e.g. after a git operation). */
export function refreshGitStatus(workDir: string): void {
  fetchAndNotify(workDir, true);
}
