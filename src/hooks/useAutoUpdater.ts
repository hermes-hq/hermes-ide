import { useState, useEffect, useCallback, useRef } from "react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { checkForUpdate } from "../api/updater";

/**
 * Test-only escape hatch for e2e runs. Only read when the frontend is built
 * with VITE_HERMES_E2E=1 (the same flag that loads `src/e2e/hooks.ts`), so
 * it is compiled out of normal builds. Lets a scenario force the "update
 * ready" state without reaching a real update server, and records
 * install/relaunch attempts instead of tearing the test app down — see
 * N10's real-app scenario.
 */
declare global {
  interface Window {
    __HERMES_TEST_UPDATE__?: {
      forcedUpdate: { version: string; body?: string } | null;
      installCalls: number;
      relaunchCalls: number;
    };
  }
}

function testUpdateOverride() {
  // Dead code outside the e2e build: Vite inlines the flag, so normal
  // builds never read the global.
  if (import.meta.env.VITE_HERMES_E2E !== "1") return undefined;
  return typeof window !== "undefined" ? window.__HERMES_TEST_UPDATE__ : undefined;
}

/** Builds a fake `Update` from a forced test override — real enough for the
 *  hook's state machine, but its `download`/`install` never touch the
 *  network or the real installer. */
function fakeUpdateFromOverride(
  forced: { version: string; body?: string },
  override: NonNullable<Window["__HERMES_TEST_UPDATE__"]>,
): Update {
  return {
    version: forced.version,
    body: forced.body ?? "",
    download: async (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 0 } });
      onEvent?.({ event: "Finished" });
    },
    install: async () => {
      override.installCalls += 1;
    },
  } as unknown as Update;
}

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
  /** Install-and-relaunch in progress (after the user clicks "Install & Relaunch") */
  installing: boolean;
  /** Count of sessions currently working (agent busy, or a terminal command
   *  running) — mirrors the `busySessionCount` argument. While this is
   *  greater than zero the update waits instead of relaunching (N10). */
  busySessionCount: number;
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
  installing: false,
  busySessionCount: 0,
};

const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STALL_TIMEOUT_MS = 15_000;

// e2e/CI builds (`VITE_HERMES_E2E=1`, set by e2e/app/build.mjs) never poll
// for updates — a proof-rig run or CI job should never talk to the update
// endpoint on a timer. `manualCheck()` (behind an explicit user action)
// still works, matching how analytics still works if triggered directly.
const isE2eBuild = import.meta.env.VITE_HERMES_E2E === "1";

/**
 * @param busySessionCount Number of sessions currently working (agent busy,
 *   or a terminal command running). While greater than zero, installing is
 *   deferred so an update can never kill a working agent (N10) — the
 *   dialog shows a waiting message instead, with a "Relaunch now" override.
 */
export function useAutoUpdater(busySessionCount = 0) {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const updateRef = useRef<Update | null>(null);
  const downloadingRef = useRef(false);
  const installingRef = useRef(false);
  const cancelledRef = useRef(false);
  const lastProgressRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busySessionCountRef = useRef(busySessionCount);

  useEffect(() => {
    busySessionCountRef.current = busySessionCount;
    setState((s) => (s.busySessionCount === busySessionCount ? s : { ...s, busySessionCount }));
  }, [busySessionCount]);

  const doCheck = useCallback(async () => {
    // Skip periodic checks while download or install is in progress
    if (downloadingRef.current || installingRef.current) return;

    try {
      // A test build may force an update; otherwise the check runs in the
      // backend so the stable/beta channel setting applies.
      const override = testUpdateOverride();
      const update = override?.forcedUpdate
        ? fakeUpdateFromOverride(override.forcedUpdate, override)
        : await checkForUpdate();
      if (update) {
        setState((s) => {
          // Don't clobber state during an active download or install
          if (s.downloading || s.installing) return s;

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

  // Check on launch (after delay) + periodically. Never in an e2e/CI build.
  useEffect(() => {
    if (isE2eBuild) return;
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

  const installAndRelaunch = useCallback(async (
    beforeInstall?: () => Promise<void>,
    options?: { force?: boolean },
  ) => {
    const update = updateRef.current;
    if (!update) return;
    // Re-entrancy guard — multiple rapid clicks fire only one install pipeline
    if (installingRef.current) return;
    // Never kill a working agent (N10): wait for every session to go idle
    // unless the user explicitly overrides with "Relaunch now".
    if (busySessionCountRef.current > 0 && !options?.force) return;
    installingRef.current = true;
    // Flip UI to "Installing…" BEFORE any slow pre-step (e.g. saveWorkspace)
    setState((s) => ({ ...s, installing: true, error: false }));

    try {
      if (beforeInstall) await beforeInstall();
      await update.install();
      const override = testUpdateOverride();
      if (override) {
        // e2e run: record the attempt instead of tearing the test app down.
        override.relaunchCalls += 1;
      } else {
        await relaunch();
      }
      // Process is being torn down for relaunch — we don't normally reach here.
    } catch {
      installingRef.current = false;
      // Keep ready: true so the correct "Install failed" message shows
      // and the "Install & Relaunch" button remains visible for retry
      setState((s) => ({ ...s, installing: false, error: true }));
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
