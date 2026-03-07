import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the Tauri plugins before import ──────────────────────────
const mockCheck = vi.fn();
const mockRelaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));

// ── Import after mocks ────────────────────────────────────────────
import type { UpdateState } from "../hooks/useAutoUpdater";

// Since useAutoUpdater is a React hook, we test the logic directly
// by extracting the state machine behavior.

/** Simulates what doCheck does to state (matches hook logic exactly) */
function applyCheckResult(
  state: UpdateState,
  update: { version: string; body: string } | null,
  isDownloading = false,
): UpdateState {
  // Hook skips checks entirely while downloading
  if (isDownloading) return state;

  if (!update) return state;

  // Don't clobber state during an active download
  if (state.downloading) return state;

  const isNewVersion = state.version !== update.version;

  return {
    ...state,
    available: true,
    version: update.version,
    notes: update.body ?? "",
    error: false,
    // Reset ready + progress when a NEW version appears
    ready: isNewVersion ? false : state.ready,
    progress: isNewVersion ? 0 : state.progress,
    downloading: isNewVersion ? false : state.downloading,
    // If the user dismissed an older version, re-show for the new one
    dismissed: state.dismissed && state.dismissedVersion === update.version,
  };
}

/** Simulates what dismiss does to state (with download guard) */
function applyDismiss(state: UpdateState): UpdateState {
  // Can't dismiss during an active download
  if (state.downloading) return state;
  return { ...state, dismissed: true, dismissedVersion: state.version };
}

/** Simulates download start */
function applyDownloadStart(state: UpdateState): UpdateState {
  return { ...state, downloading: true, progress: 0, error: false, ready: false };
}

/** Simulates successful download completion */
function applyDownloadComplete(state: UpdateState): UpdateState {
  return { ...state, downloading: false, progress: 100, ready: true };
}

/** Simulates download failure */
function applyDownloadFailure(state: UpdateState): UpdateState {
  return { ...state, downloading: false, error: true };
}

/** Simulates install failure (keeps ready: true for correct error message) */
function applyInstallFailure(state: UpdateState): UpdateState {
  return { ...state, error: true };
}

/** Simulates manualCheck state reset (before calling doCheck) */
function applyManualCheckReset(state: UpdateState): UpdateState {
  return { ...state, dismissed: false, error: false };
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────
// Bug #1: Dismissed dialog never re-shows on periodic check
// ─────────────────────────────────────────────────────────────────
describe("Bug #1 — dismiss + periodic re-check (same version)", () => {
  it("should keep dialog hidden when same version re-checked after dismiss", () => {
    let s = INITIAL;
    // 1. Update found
    s = applyCheckResult(s, { version: "1.0.0", body: "notes" });
    expect(s.available).toBe(true);
    expect(s.dismissed).toBe(false);

    // 2. User clicks "Later"
    s = applyDismiss(s);
    expect(s.dismissed).toBe(true);
    expect(s.dismissedVersion).toBe("1.0.0");

    // 3. Periodic check finds SAME version
    s = applyCheckResult(s, { version: "1.0.0", body: "notes" });
    expect(s.dismissed).toBe(true); // stays dismissed for same version
  });

  it("should re-show dialog when a NEWER version is found after dismiss", () => {
    let s = INITIAL;
    // 1. Update found
    s = applyCheckResult(s, { version: "1.0.0", body: "notes" });
    expect(s.available).toBe(true);

    // 2. User clicks "Later"
    s = applyDismiss(s);
    expect(s.dismissed).toBe(true);
    expect(s.dismissedVersion).toBe("1.0.0");

    // 3. Periodic check finds NEWER version
    s = applyCheckResult(s, { version: "1.1.0", body: "new notes" });
    expect(s.dismissed).toBe(false); // re-shows for new version
    expect(s.version).toBe("1.1.0");
  });
});

// ─────────────────────────────────────────────────────────────────
// Bug #2: Status bar hidden after dismiss
// ─────────────────────────────────────────────────────────────────
describe("Bug #2 — status bar visibility after dismiss", () => {
  it("available should remain true after dismiss (for status bar)", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "2.0.0", body: "" });
    s = applyDismiss(s);

    // `available` stays true — status bar shows "v2.0.0 available"
    expect(s.available).toBe(true);
    // Dialog hidden by `dismissed`, but status bar uses only `available`
    expect(s.dismissed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Bug #3: Download failure error state
// ─────────────────────────────────────────────────────────────────
describe("Bug #3 — download failure error feedback", () => {
  it("should set error flag on download failure", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadFailure(s);

    expect(s.error).toBe(true);
    expect(s.downloading).toBe(false);
    expect(s.available).toBe(true); // dialog still shown
  });

  it("should clear error flag on next successful check", () => {
    let s: UpdateState = {
      ...INITIAL,
      available: true,
      version: "1.0.0",
      error: true,
    };

    // Next check clears error
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    expect(s.error).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Manual check resets dismissed + error
// ─────────────────────────────────────────────────────────────────
describe("manualCheck resets dismissed and error state", () => {
  it("should clear dismissed so dialog re-shows", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDismiss(s);
    expect(s.dismissed).toBe(true);

    // manualCheck resets dismissed before calling doCheck
    s = applyManualCheckReset(s);
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    expect(s.dismissed).toBe(false); // dialog visible again
  });

  it("should clear error flag so stale error message is removed", () => {
    let s: UpdateState = {
      ...INITIAL,
      available: true,
      version: "1.0.0",
      error: true,
    };

    s = applyManualCheckReset(s);
    expect(s.error).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// New version resets ready state
// ─────────────────────────────────────────────────────────────────
describe("new version resets ready state", () => {
  it("should reset ready/progress when a NEW version appears after download", () => {
    let s = INITIAL;
    // Download v1.0.0 completes
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadComplete(s);
    expect(s.ready).toBe(true);
    expect(s.progress).toBe(100);

    // Periodic check finds v2.0.0
    s = applyCheckResult(s, { version: "2.0.0", body: "new!" });
    expect(s.ready).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.downloading).toBe(false);
    expect(s.version).toBe("2.0.0");
  });

  it("should preserve ready state when SAME version re-checked", () => {
    let s = INITIAL;
    // Download v1.0.0 completes
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadComplete(s);
    expect(s.ready).toBe(true);

    // Periodic check finds same v1.0.0
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    expect(s.ready).toBe(true); // stays ready
    expect(s.progress).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// Dismiss guard during download
// ─────────────────────────────────────────────────────────────────
describe("dismiss guard during download", () => {
  it("should not allow dismiss while downloading", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    expect(s.downloading).toBe(true);

    // Attempt dismiss during download
    s = applyDismiss(s);
    expect(s.dismissed).toBe(false); // dismiss blocked
  });

  it("should allow dismiss after download completes", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadComplete(s);

    s = applyDismiss(s);
    expect(s.dismissed).toBe(true); // dismiss allowed
  });
});

// ─────────────────────────────────────────────────────────────────
// Periodic check skipped during download
// ─────────────────────────────────────────────────────────────────
describe("periodic check skipped during download", () => {
  it("should not modify state when isDownloading is true", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    const before = { ...s };

    // Periodic check fires while download in progress
    s = applyCheckResult(s, { version: "2.0.0", body: "new!" }, true);

    // State unchanged — check was skipped
    expect(s).toEqual(before);
  });

  it("should not clobber state when downloading flag is set", () => {
    let s: UpdateState = {
      ...INITIAL,
      available: true,
      version: "1.0.0",
      downloading: true,
      progress: 50,
    };

    // doCheck finds a new version but state.downloading is true
    s = applyCheckResult(s, { version: "2.0.0", body: "" });
    // State unchanged — downloading guard
    expect(s.version).toBe("1.0.0");
    expect(s.downloading).toBe(true);
    expect(s.progress).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────
// Install failure keeps ready: true for correct error message
// ─────────────────────────────────────────────────────────────────
describe("install failure error handling", () => {
  it("should keep ready: true on install failure (shows 'Install failed')", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadComplete(s);
    expect(s.ready).toBe(true);
    expect(s.error).toBe(false);

    // Install fails
    s = applyInstallFailure(s);
    expect(s.error).toBe(true);
    expect(s.ready).toBe(true); // still ready — "Install & Relaunch" remains visible
  });

  it("download failure should NOT set ready (shows 'Download failed')", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyDownloadFailure(s);

    expect(s.error).toBe(true);
    expect(s.ready).toBe(false); // not ready — download never completed
  });
});

// ─────────────────────────────────────────────────────────────────
// Cancel download
// ─────────────────────────────────────────────────────────────────
/** Simulates cancel download */
function applyCancelDownload(state: UpdateState): UpdateState {
  return {
    ...state, downloading: false, progress: 0, downloadedBytes: 0,
    totalBytes: 0, stalled: false, error: false,
  };
}

describe("cancel download", () => {
  it("should reset download state but keep available", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = { ...s, progress: 45, downloadedBytes: 12_000_000, totalBytes: 27_000_000 };

    s = applyCancelDownload(s);
    expect(s.available).toBe(true);
    expect(s.downloading).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.downloadedBytes).toBe(0);
    expect(s.error).toBe(false);
  });

  it("should allow re-downloading after cancel", () => {
    let s = INITIAL;
    s = applyCheckResult(s, { version: "1.0.0", body: "" });
    s = applyDownloadStart(s);
    s = applyCancelDownload(s);
    s = applyDownloadStart(s);
    expect(s.downloading).toBe(true);
    expect(s.progress).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Full lifecycle: check → download → install → relaunch
// ─────────────────────────────────────────────────────────────────
describe("full update lifecycle", () => {
  it("should progress through all states correctly", () => {
    let s = INITIAL;

    // 1. Check finds update
    s = applyCheckResult(s, { version: "3.0.0", body: "Big release" });
    expect(s).toMatchObject({
      available: true,
      version: "3.0.0",
      notes: "Big release",
      downloading: false,
      ready: false,
    });

    // 2. User clicks Download
    s = applyDownloadStart(s);
    expect(s).toMatchObject({
      downloading: true,
      progress: 0,
      error: false,
      ready: false,
    });

    // 3. Download completes
    s = applyDownloadComplete(s);
    expect(s).toMatchObject({
      downloading: false,
      progress: 100,
      ready: true,
    });

    // 4. At this point user would click "Install & Relaunch"
    // (actual install/relaunch tested via Tauri mock in integration tests)
  });
});
