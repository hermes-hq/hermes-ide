// ─── Feature Tracks: attach sessions to the watcher ───────────────────
//
// F28. Every local session is attached to its working directory: the
// backend reads the folder once and then reports changes; the store folds
// them in. One listener for the change event lives for the app's lifetime.

import { useEffect, useRef } from "react";
import { onTrackChanged, trackReadFile, trackRevertGate, trackUnwatch, trackWatch } from "./api";
import { applyTrackSnapshot, configureTrackStore, forgetTrack } from "./store";
import type { AttachedSession } from "./rules";

let channelStarted = false;

function ensureChannel(): void {
  if (channelStarted) return;
  channelStarted = true;
  configureTrackStore({ revertGate: trackRevertGate, readFile: trackReadFile });
  void onTrackChanged((snapshot) => {
    applyTrackSnapshot(snapshot);
  }).catch((e) => {
    channelStarted = false;
    console.error("[track] could not listen for changes:", e);
  });
}

/**
 * Keep the watcher in step with the open sessions. `sessions` is the live
 * list; SSH sessions are skipped (their files are elsewhere).
 */
export function useTrackWatching(sessions: readonly AttachedSession[], enabled: boolean): void {
  const watched = useRef(new Map<string, string>());
  const latest = useRef(sessions);
  latest.current = sessions;

  useEffect(() => {
    if (!enabled) return;
    ensureChannel();
    configureTrackStore({ sessions: () => latest.current });
  }, [enabled]);

  const key = enabled
    ? sessions
        .filter((s) => !s.ssh_info)
        .map((s) => `${s.id}\u0000${s.working_directory}`)
        .sort()
        .join("\u0001")
    : "";

  useEffect(() => {
    if (!enabled) return;
    const want = new Map<string, string>();
    for (const s of latest.current) if (!s.ssh_info && s.working_directory) want.set(s.id, s.working_directory);
    const have = watched.current;
    for (const [id, path] of [...have]) {
      if (want.get(id) === path) continue;
      have.delete(id);
      void trackUnwatch(id).catch(() => {});
      if (![...have.values()].includes(path) && ![...want.values()].includes(path)) forgetTrack(path);
    }
    for (const [id, path] of want) {
      if (have.get(id) === path) continue;
      have.set(id, path);
      void trackWatch(id, path)
        .then((snapshot) => {
          if (watched.current.get(id) === path) applyTrackSnapshot(snapshot);
        })
        .catch((e) => console.warn("[track] could not watch", path, e));
    }
  }, [key, enabled]);
}
