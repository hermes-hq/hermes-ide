import { useState, useEffect, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateState {
  /** An update is available */
  available: boolean;
  /** Version string of the available update */
  version: string;
  /** Release notes markdown */
  notes: string;
  /** Currently downloading */
  downloading: boolean;
  /** Download progress 0-100 */
  progress: number;
  /** Bytes downloaded so far */
  downloadedBytes: number;
  /** Total content length in bytes (0 if unknown) */
  totalBytes: number;
  /** Download finished, ready to install */
  ready: boolean;
  /** User dismissed the dialog — hide until next launch */
  dismissed: boolean;
  /** The version string the user dismissed (so a newer version re-shows the dialog) */
  dismissedVersion: string;
  /** Download failed — show error feedback */
  error: boolean;
  /** Download appears stalled (no progress for 15s) */
  stalled: boolean;
}

const INITIAL: UpdateState = {
  available: false,
  version: "",
  notes: "",
  downloading: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  ready: false,
  dismissed: false,
  dismissedVersion: "",
  error: false,
  stalled: false,
};

const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STALL_TIMEOUT_MS = 15_000;

export function useAutoUpdater() {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const updateRef = useRef<Update | null>(null);
  const downloadingRef = useRef(false);
  const cancelledRef = useRef(false);
  const lastProgressRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doCheck = useCallback(async () => {
    // Skip periodic checks while a download is in progress or install is ready
    if (downloadingRef.current) return;

    try {
      const update = await check();
      if (update) {
        setState((s) => {
          // Don't clobber state during an active download
          if (s.downloading) return s;

          const isNewVersion = s.version !== update.version;
          // Only replace the update ref if not mid-download/ready,
          // or if a genuinely new version appeared
          if (!s.ready || isNewVersion) {
            updateRef.current = update;
          }

          return {
            ...s,
            available: true,
            version: update.version,
            notes: update.body ?? "",
            error: false,
            // Reset ready + progress when a NEW version appears
            ready: isNewVersion ? false : s.ready,
            progress: isNewVersion ? 0 : s.progress,
            downloading: isNewVersion ? false : s.downloading,
            // If the user dismissed an older version, re-show for the new one
            dismissed: s.dismissed && s.dismissedVersion === update.version,
          };
        });
      } else {
        // No update available — clear the ref only if not mid-download/ready
        setState((s) => {
          if (!s.ready && !s.downloading) {
            updateRef.current = null;
          }
          return s;
        });
      }
    } catch {
      // Fail silently — no internet, endpoint down, dev mode, etc.
    }
  }, []);

  // Check on launch (after delay) + periodically
  useEffect(() => {
    const timeout = setTimeout(doCheck, CHECK_DELAY_MS);
    const interval = setInterval(doCheck, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      if (stallTimerRef.current) {
        clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
  }, [doCheck]);

  const dismiss = useCallback(() => {
    setState((s) => {
      // Can't dismiss during an active download
      if (s.downloading) return s;
      return { ...s, dismissed: true, dismissedVersion: s.version };
    });
  }, []);

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) {
      clearInterval(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const download = useCallback(async () => {
    const update = updateRef.current;
    // Guard against double-click / concurrent downloads
    if (!update || downloadingRef.current) return;
    downloadingRef.current = true;
    cancelledRef.current = false;
    lastProgressRef.current = Date.now();

    setState((s) => ({
      ...s, downloading: true, progress: 0, downloadedBytes: 0,
      totalBytes: 0, error: false, ready: false, stalled: false,
    }));

    // Stall detection: check every 5s if progress has stalled
    stallTimerRef.current = setInterval(() => {
      if (Date.now() - lastProgressRef.current > STALL_TIMEOUT_MS) {
        setState((s) => s.downloading ? { ...s, stalled: true } : s);
      }
    }, 5000);

    try {
      let contentLength = 0;
      let downloaded = 0;

      await update.download((event) => {
        if (cancelledRef.current) return;
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            setState((s) => ({ ...s, totalBytes: contentLength }));
            break;
          case "Progress": {
            downloaded += event.data.chunkLength;
            lastProgressRef.current = Date.now();
            const pct = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
            setState((s) => ({ ...s, progress: pct, downloadedBytes: downloaded, stalled: false }));
            break;
          }
          case "Finished":
            break;
        }
      });

      clearStallTimer();

      if (cancelledRef.current) {
        setState((s) => ({ ...s, downloading: false, progress: 0, downloadedBytes: 0, stalled: false }));
      } else {
        // Download complete — wait for user to press "Install & Relaunch"
        setState((s) => ({ ...s, downloading: false, progress: 100, ready: true, stalled: false }));
      }
    } catch {
      clearStallTimer();
      if (!cancelledRef.current) {
        setState((s) => ({ ...s, downloading: false, error: true, stalled: false }));
      }
    } finally {
      downloadingRef.current = false;
    }
  }, [clearStallTimer]);

  const cancelDownload = useCallback(() => {
    cancelledRef.current = true;
    clearStallTimer();
    setState((s) => ({
      ...s, downloading: false, progress: 0, downloadedBytes: 0,
      totalBytes: 0, stalled: false, error: false,
    }));
    downloadingRef.current = false;
  }, [clearStallTimer]);

  const installAndRelaunch = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    try {
      await update.install();
      await relaunch();
    } catch {
      // Keep ready: true so the correct "Install failed" message shows
      // and the "Install & Relaunch" button remains visible for retry
      setState((s) => ({ ...s, error: true }));
    }
  }, []);

  const manualCheck = useCallback(async () => {
    setState((s) => ({ ...s, dismissed: false, error: false }));
    await doCheck();
    // Return whether an update was found
    return updateRef.current !== null;
  }, [doCheck]);

  return { state, dismiss, download, cancelDownload, installAndRelaunch, manualCheck };
}
