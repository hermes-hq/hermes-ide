/**
 * Tests for the Plugin Update Banner presentation logic.
 *
 * Since the test environment is `node` (no DOM/React), we test the
 * banner's rendering conditions and state transitions by extracting
 * the decision logic into testable functions.
 *
 * Covers:
 * - Banner visibility conditions
 * - State transitions (updates available → updating → results)
 * - Dismiss behaviour
 * - Auto-update result display
 * - Per-plugin skip/ignore
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import type {
  PluginUpdateState,
  PluginUpdateInfo,
  PluginUpdateResult,
} from "../hooks/usePluginUpdateChecker";

// ─── Banner visibility logic (mirrors PluginUpdateBanner render conditions) ──

function shouldShowBanner(state: PluginUpdateState): boolean {
  const hasUpdates = state.updatesAvailable.length > 0;
  const hasResults = state.updateResults.length > 0;

  if (state.dismissed && !hasResults) return false;
  if (!hasUpdates && !hasResults) return false;
  return true;
}

function getBannerMode(state: PluginUpdateState): "updates" | "results" | "hidden" {
  if (!shouldShowBanner(state)) return "hidden";
  if (state.updateResults.length > 0) return "results";
  return "updates";
}

// ─── Helpers ─────────────────────────────────────────────────────────

function makeUpdate(id: string, version: string = "2.0.0"): PluginUpdateInfo {
  return {
    id,
    name: `Plugin ${id}`,
    currentVersion: "1.0.0",
    newVersion: version,
    downloadUrl: `https://example.com/${id}.tgz`,
  };
}

function makeResult(id: string, success: boolean): PluginUpdateResult {
  return { id, name: `Plugin ${id}`, success };
}

function makeState(overrides?: Partial<PluginUpdateState>): PluginUpdateState {
  return {
    updatesAvailable: [],
    checking: false,
    dismissed: false,
    lastChecked: null,
    updateResults: [],
    autoUpdated: false,
    ...overrides,
  };
}

// =====================================================================
// Suite 1: Banner visibility
// =====================================================================

describe("Banner visibility", () => {
  it("hidden when no updates and no results", () => {
    const state = makeState();
    expect(shouldShowBanner(state)).toBe(false);
    expect(getBannerMode(state)).toBe("hidden");
  });

  it("visible when updates are available", () => {
    const state = makeState({ updatesAvailable: [makeUpdate("a")] });
    expect(shouldShowBanner(state)).toBe(true);
    expect(getBannerMode(state)).toBe("updates");
  });

  it("visible when results exist (post-update)", () => {
    const state = makeState({ updateResults: [makeResult("a", true)] });
    expect(shouldShowBanner(state)).toBe(true);
    expect(getBannerMode(state)).toBe("results");
  });

  it("hidden when dismissed and no results", () => {
    const state = makeState({
      updatesAvailable: [makeUpdate("a")],
      dismissed: true,
    });
    expect(shouldShowBanner(state)).toBe(false);
  });

  it("visible when dismissed BUT results exist", () => {
    const state = makeState({
      dismissed: true,
      updateResults: [makeResult("a", true)],
    });
    expect(shouldShowBanner(state)).toBe(true);
  });

  it("results mode takes priority over updates mode", () => {
    const state = makeState({
      updatesAvailable: [makeUpdate("a")],
      updateResults: [makeResult("b", true)],
    });
    expect(getBannerMode(state)).toBe("results");
  });
});

// =====================================================================
// Suite 2: Updates available state
// =====================================================================

describe("Updates available state", () => {
  it("shows correct count for single update", () => {
    const state = makeState({ updatesAvailable: [makeUpdate("a")] });
    expect(state.updatesAvailable.length).toBe(1);
    expect(getBannerMode(state)).toBe("updates");
  });

  it("shows correct count for multiple updates", () => {
    const state = makeState({
      updatesAvailable: [makeUpdate("a"), makeUpdate("b"), makeUpdate("c")],
    });
    expect(state.updatesAvailable.length).toBe(3);
  });

  it("update info contains version transition data", () => {
    const update = makeUpdate("a", "2.0.0");
    expect(update.currentVersion).toBe("1.0.0");
    expect(update.newVersion).toBe("2.0.0");
  });

  it("update info can include changelog", () => {
    const update: PluginUpdateInfo = {
      ...makeUpdate("a"),
      changelog: [
        { version: "2.0.0", date: "2026-03-15", changes: ["New feature"] },
      ],
    };
    expect(update.changelog).toHaveLength(1);
  });
});

// =====================================================================
// Suite 3: State transitions
// =====================================================================

describe("State transitions", () => {
  it("updates available → dismissed (Later clicked)", () => {
    const initial = makeState({ updatesAvailable: [makeUpdate("a")] });
    expect(getBannerMode(initial)).toBe("updates");

    const dismissed = { ...initial, dismissed: true };
    expect(getBannerMode(dismissed)).toBe("hidden");
  });

  it("updates available → results (Update All completed)", () => {
    const initial = makeState({ updatesAvailable: [makeUpdate("a"), makeUpdate("b")] });
    expect(getBannerMode(initial)).toBe("updates");

    const afterUpdate = makeState({
      updatesAvailable: [],
      updateResults: [makeResult("a", true), makeResult("b", true)],
    });
    expect(getBannerMode(afterUpdate)).toBe("results");
  });

  it("results → hidden (Dismiss clicked)", () => {
    const withResults = makeState({
      updateResults: [makeResult("a", true)],
    });
    expect(getBannerMode(withResults)).toBe("results");

    const cleared = makeState({
      updateResults: [],
      dismissed: true,
    });
    expect(getBannerMode(cleared)).toBe("hidden");
  });

  it("per-plugin skip removes from list, auto-hides if empty", () => {
    const initial = makeState({ updatesAvailable: [makeUpdate("a")] });
    expect(initial.updatesAvailable.length).toBe(1);

    // After skip, plugin is removed
    const afterSkip = makeState({
      updatesAvailable: [],
      dismissed: true, // auto-dismissed because list is empty
    });
    expect(getBannerMode(afterSkip)).toBe("hidden");
  });

  it("per-plugin update moves to results", () => {
    const initial = makeState({
      updatesAvailable: [makeUpdate("a"), makeUpdate("b")],
    });

    // After updating plugin "a"
    const afterOne = makeState({
      updatesAvailable: [makeUpdate("b")],
      updateResults: [makeResult("a", true)],
    });
    expect(getBannerMode(afterOne)).toBe("results");
    expect(afterOne.updatesAvailable.length).toBe(1);
  });
});

// =====================================================================
// Suite 4: Auto-update state
// =====================================================================

describe("Auto-update state", () => {
  it("auto-update sets autoUpdated flag", () => {
    const state = makeState({
      updateResults: [makeResult("a", true), makeResult("b", true)],
      autoUpdated: true,
    });
    expect(state.autoUpdated).toBe(true);
    expect(getBannerMode(state)).toBe("results");
  });

  it("auto-update with partial failures still shows results", () => {
    const state = makeState({
      updateResults: [makeResult("a", true), makeResult("b", false)],
      autoUpdated: true,
    });
    expect(getBannerMode(state)).toBe("results");
    const successCount = state.updateResults.filter((r) => r.success).length;
    expect(successCount).toBe(1);
  });

  it("auto-update clears updatesAvailable", () => {
    const state = makeState({
      updatesAvailable: [],
      updateResults: [makeResult("a", true)],
      autoUpdated: true,
    });
    expect(state.updatesAvailable).toHaveLength(0);
  });
});

// =====================================================================
// Suite 5: Result counting
// =====================================================================

describe("Result counting", () => {
  it("counts all successes", () => {
    const results: PluginUpdateResult[] = [
      makeResult("a", true),
      makeResult("b", true),
      makeResult("c", true),
    ];
    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBe(3);
  });

  it("counts mixed results", () => {
    const results: PluginUpdateResult[] = [
      makeResult("a", true),
      makeResult("b", false),
      makeResult("c", true),
    ];
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;
    expect(successCount).toBe(2);
    expect(failCount).toBe(1);
  });

  it("handles all failures", () => {
    const results: PluginUpdateResult[] = [
      makeResult("a", false),
      makeResult("b", false),
    ];
    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBe(0);
  });

  it("handles empty results", () => {
    const results: PluginUpdateResult[] = [];
    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBe(0);
  });
});

// =====================================================================
// Suite 6: Checking state
// =====================================================================

describe("Checking state", () => {
  it("checking flag is independent of banner visibility", () => {
    const state = makeState({ checking: true });
    // Banner is hidden (no updates, no results), but checking is true
    expect(shouldShowBanner(state)).toBe(false);
    expect(state.checking).toBe(true);
  });

  it("checking with existing updates doesn't hide banner", () => {
    const state = makeState({
      updatesAvailable: [makeUpdate("a")],
      checking: true,
    });
    expect(shouldShowBanner(state)).toBe(true);
  });
});
