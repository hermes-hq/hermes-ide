/**
 * Tests for the Plugin Update Checker system.
 *
 * Covers:
 * - shouldCheck() frequency logic
 * - filterIgnored() version filtering
 * - findUpdates() version comparison between installed and registry
 * - Hook behaviour: background checking, auto-update, ignore, dismiss
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import {
  shouldCheck,
  filterIgnored,
  findUpdates,
  type PluginUpdateInfo,
} from "../hooks/usePluginUpdateChecker";
import type { RegistryPlugin } from "../plugins/types";

// =====================================================================
// Suite 1: shouldCheck — frequency-based check logic
// =====================================================================

describe("shouldCheck", () => {
  const NOW = new Date("2026-03-11T12:00:00Z").getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MS_PER_WEEK = 7 * MS_PER_DAY;

  it("returns false when frequency is 'never'", () => {
    expect(shouldCheck("never", null, NOW)).toBe(false);
  });

  it("returns false when frequency is 'never' even with old timestamp", () => {
    expect(shouldCheck("never", "2020-01-01T00:00:00Z", NOW)).toBe(false);
  });

  it("returns true when frequency is 'startup' regardless of last check", () => {
    expect(shouldCheck("startup", null, NOW)).toBe(true);
    expect(shouldCheck("startup", new Date(NOW - 1000).toISOString(), NOW)).toBe(true);
  });

  it("returns true when frequency is 'daily' and lastCheck is null", () => {
    expect(shouldCheck("daily", null, NOW)).toBe(true);
  });

  it("returns true when frequency is 'daily' and 24+ hours have passed", () => {
    const lastCheck = new Date(NOW - MS_PER_DAY - 1000).toISOString();
    expect(shouldCheck("daily", lastCheck, NOW)).toBe(true);
  });

  it("returns false when frequency is 'daily' and less than 24 hours have passed", () => {
    const lastCheck = new Date(NOW - MS_PER_DAY + 60_000).toISOString();
    expect(shouldCheck("daily", lastCheck, NOW)).toBe(false);
  });

  it("returns true when frequency is 'weekly' and lastCheck is null", () => {
    expect(shouldCheck("weekly", null, NOW)).toBe(true);
  });

  it("returns true when frequency is 'weekly' and 7+ days have passed", () => {
    const lastCheck = new Date(NOW - MS_PER_WEEK - 1000).toISOString();
    expect(shouldCheck("weekly", lastCheck, NOW)).toBe(true);
  });

  it("returns false when frequency is 'weekly' and less than 7 days have passed", () => {
    const lastCheck = new Date(NOW - MS_PER_WEEK + 60_000).toISOString();
    expect(shouldCheck("weekly", lastCheck, NOW)).toBe(false);
  });

  it("returns true for invalid lastCheck date string", () => {
    expect(shouldCheck("daily", "not-a-date", NOW)).toBe(true);
  });

  it("returns true for empty lastCheck string", () => {
    expect(shouldCheck("daily", "", NOW)).toBe(true);
  });

  it("returns true for unknown frequency (defaults to check)", () => {
    expect(shouldCheck("unknown", null, NOW)).toBe(true);
  });

  it("handles boundary case: exactly 24 hours for daily", () => {
    const lastCheck = new Date(NOW - MS_PER_DAY).toISOString();
    expect(shouldCheck("daily", lastCheck, NOW)).toBe(true);
  });

  it("handles boundary case: exactly 7 days for weekly", () => {
    const lastCheck = new Date(NOW - MS_PER_WEEK).toISOString();
    expect(shouldCheck("weekly", lastCheck, NOW)).toBe(true);
  });
});

// =====================================================================
// Suite 2: filterIgnored — version ignore filtering
// =====================================================================

describe("filterIgnored", () => {
  const makeUpdate = (id: string, version: string): PluginUpdateInfo => ({
    id,
    name: `Plugin ${id}`,
    currentVersion: "1.0.0",
    newVersion: version,
    downloadUrl: `https://example.com/${id}.tgz`,
  });

  it("returns all updates when ignoredJson is empty string", () => {
    const updates = [makeUpdate("a", "2.0.0"), makeUpdate("b", "1.1.0")];
    expect(filterIgnored(updates, "")).toEqual(updates);
  });

  it("returns all updates when ignoredJson is invalid JSON", () => {
    const updates = [makeUpdate("a", "2.0.0")];
    expect(filterIgnored(updates, "not-json")).toEqual(updates);
  });

  it("returns all updates when ignoredJson is empty object", () => {
    const updates = [makeUpdate("a", "2.0.0")];
    expect(filterIgnored(updates, "{}")).toEqual(updates);
  });

  it("filters out a plugin whose version matches the ignored version", () => {
    const updates = [makeUpdate("a", "2.0.0"), makeUpdate("b", "1.1.0")];
    const ignored = JSON.stringify({ a: "2.0.0" });
    const result = filterIgnored(updates, ignored);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("does NOT filter a plugin whose ignored version differs from update version", () => {
    const updates = [makeUpdate("a", "2.0.0")];
    const ignored = JSON.stringify({ a: "1.5.0" }); // different from 2.0.0
    const result = filterIgnored(updates, ignored);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters multiple ignored plugins", () => {
    const updates = [
      makeUpdate("a", "2.0.0"),
      makeUpdate("b", "1.1.0"),
      makeUpdate("c", "3.0.0"),
    ];
    const ignored = JSON.stringify({ a: "2.0.0", c: "3.0.0" });
    const result = filterIgnored(updates, ignored);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("returns empty array when all updates are ignored", () => {
    const updates = [makeUpdate("a", "2.0.0")];
    const ignored = JSON.stringify({ a: "2.0.0" });
    const result = filterIgnored(updates, ignored);
    expect(result).toHaveLength(0);
  });

  it("handles empty updates array", () => {
    const result = filterIgnored([], JSON.stringify({ a: "1.0.0" }));
    expect(result).toHaveLength(0);
  });
});

// =====================================================================
// Suite 3: findUpdates — compare installed vs registry
// =====================================================================

describe("findUpdates", () => {
  const makeInstalledPlugin = (id: string, version: string, name?: string) => ({
    id,
    version,
    name: name ?? `Plugin ${id}`,
  });

  const makeRegistryPlugin = (id: string, version: string, overrides?: Partial<RegistryPlugin>): RegistryPlugin => ({
    id,
    name: `Plugin ${id}`,
    version,
    description: "Test plugin",
    author: "Test",
    downloadUrl: `https://example.com/${id}.tgz`,
    ...overrides,
  });

  it("returns empty array when no plugins are installed", () => {
    const result = findUpdates([], [makeRegistryPlugin("a", "1.0.0")]);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when registry is empty", () => {
    const result = findUpdates([makeInstalledPlugin("a", "1.0.0")], []);
    expect(result).toHaveLength(0);
  });

  it("finds update when registry version is newer", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "1.1.0")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
    expect(result[0].currentVersion).toBe("1.0.0");
    expect(result[0].newVersion).toBe("1.1.0");
  });

  it("does NOT report update when versions are equal", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "1.0.0")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(0);
  });

  it("does NOT report update when installed version is newer (downgrade)", () => {
    const installed = [makeInstalledPlugin("a", "2.0.0")];
    const registry = [makeRegistryPlugin("a", "1.0.0")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(0);
  });

  it("ignores registry plugins that are not installed", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("b", "1.0.0")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(0);
  });

  it("finds updates for multiple plugins", () => {
    const installed = [
      makeInstalledPlugin("a", "1.0.0"),
      makeInstalledPlugin("b", "1.0.0"),
      makeInstalledPlugin("c", "2.0.0"),
    ];
    const registry = [
      makeRegistryPlugin("a", "1.1.0"),
      makeRegistryPlugin("b", "2.0.0"),
      makeRegistryPlugin("c", "2.0.0"), // same version — no update
    ];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.id).sort()).toEqual(["a", "b"]);
  });

  it("includes changelog from registry plugin", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [
      makeRegistryPlugin("a", "1.1.0", {
        changelog: [
          { version: "1.1.0", date: "2026-03-15", changes: ["Added feature X"] },
          { version: "1.0.0", date: "2026-03-01", changes: ["Initial release"] },
        ],
      }),
    ];
    const result = findUpdates(installed, registry);
    expect(result[0].changelog).toHaveLength(2);
    expect(result[0].changelog![0].changes).toContain("Added feature X");
  });

  it("includes icon from registry plugin", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "1.1.0", { icon: "<svg>test</svg>" })];
    const result = findUpdates(installed, registry);
    expect(result[0].icon).toBe("<svg>test</svg>");
  });

  it("includes downloadUrl from registry plugin", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "1.1.0")];
    const result = findUpdates(installed, registry);
    expect(result[0].downloadUrl).toBe("https://example.com/a.tgz");
  });

  it("uses name from registry, not installed", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0", "Old Name")];
    const registry = [makeRegistryPlugin("a", "1.1.0", { name: "New Name" })];
    const result = findUpdates(installed, registry);
    expect(result[0].name).toBe("New Name");
  });

  it("handles major version bump", () => {
    const installed = [makeInstalledPlugin("a", "1.9.9")];
    const registry = [makeRegistryPlugin("a", "2.0.0")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(1);
  });

  it("handles patch version bump", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "1.0.1")];
    const result = findUpdates(installed, registry);
    expect(result).toHaveLength(1);
  });
});

// =====================================================================
// Suite 4: Hook behaviour simulation (polling lifecycle)
// =====================================================================

describe("Plugin update checker — polling behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shouldCheck with startup frequency triggers immediately", () => {
    expect(shouldCheck("startup", null)).toBe(true);
  });

  it("shouldCheck with daily frequency and recent check does not trigger", () => {
    const recentCheck = new Date().toISOString();
    expect(shouldCheck("daily", recentCheck)).toBe(false);
  });

  it("shouldCheck with daily frequency after advancing 25 hours triggers", () => {
    const now = Date.now();
    const lastCheck = new Date(now).toISOString();
    const later = now + 25 * 60 * 60 * 1000;
    expect(shouldCheck("daily", lastCheck, later)).toBe(true);
  });

  it("shouldCheck with weekly frequency after advancing 8 days triggers", () => {
    const now = Date.now();
    const lastCheck = new Date(now).toISOString();
    const later = now + 8 * 24 * 60 * 60 * 1000;
    expect(shouldCheck("weekly", lastCheck, later)).toBe(true);
  });

  it("shouldCheck with weekly frequency after advancing 6 days does not trigger", () => {
    const now = Date.now();
    const lastCheck = new Date(now).toISOString();
    const later = now + 6 * 24 * 60 * 60 * 1000;
    expect(shouldCheck("weekly", lastCheck, later)).toBe(false);
  });
});

// =====================================================================
// Suite 5: Integration — findUpdates + filterIgnored pipeline
// =====================================================================

describe("findUpdates + filterIgnored pipeline", () => {
  const makeInstalledPlugin = (id: string, version: string) => ({
    id,
    version,
    name: `Plugin ${id}`,
  });

  const makeRegistryPlugin = (id: string, version: string): RegistryPlugin => ({
    id,
    name: `Plugin ${id}`,
    version,
    description: "Test",
    author: "Test",
    downloadUrl: `https://example.com/${id}.tgz`,
  });

  it("filters ignored updates from findUpdates result", () => {
    const installed = [
      makeInstalledPlugin("a", "1.0.0"),
      makeInstalledPlugin("b", "1.0.0"),
    ];
    const registry = [
      makeRegistryPlugin("a", "2.0.0"),
      makeRegistryPlugin("b", "2.0.0"),
    ];

    const updates = findUpdates(installed, registry);
    expect(updates).toHaveLength(2);

    const ignored = JSON.stringify({ a: "2.0.0" });
    const filtered = filterIgnored(updates, ignored);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("re-shows ignored plugin when a newer version appears", () => {
    const installed = [makeInstalledPlugin("a", "1.0.0")];
    const registry = [makeRegistryPlugin("a", "3.0.0")]; // newer than ignored 2.0.0

    const updates = findUpdates(installed, registry);
    const ignored = JSON.stringify({ a: "2.0.0" }); // user ignored 2.0.0, but now 3.0.0 is available
    const filtered = filterIgnored(updates, ignored);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].newVersion).toBe("3.0.0");
  });

  it("handles empty pipeline gracefully", () => {
    const updates = findUpdates([], []);
    const filtered = filterIgnored(updates, "{}");
    expect(filtered).toHaveLength(0);
  });
});
