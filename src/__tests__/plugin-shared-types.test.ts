/**
 * Tests for shared plugin types and constants.
 *
 * Covers:
 * - RegistryPlugin type shape
 * - ChangelogEntry type shape
 * - REGISTRY_URL constant
 * - Type compatibility between PluginManager and shared types
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
import type { RegistryPlugin, ChangelogEntry } from "../plugins/types";
import { REGISTRY_URL } from "../plugins/constants";

// =====================================================================
// Suite 1: REGISTRY_URL constant
// =====================================================================

describe("REGISTRY_URL", () => {
  it("is a valid HTTPS URL pointing to GitHub raw", () => {
    expect(REGISTRY_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
  });

  it("ends with index.json", () => {
    expect(REGISTRY_URL).toMatch(/index\.json$/);
  });

  it("contains hermes-hq/plugins path", () => {
    expect(REGISTRY_URL).toContain("hermes-hq/plugins");
  });
});

// =====================================================================
// Suite 2: ChangelogEntry type validation
// =====================================================================

describe("ChangelogEntry type", () => {
  it("accepts a valid changelog entry", () => {
    const entry: ChangelogEntry = {
      version: "1.0.0",
      date: "2026-03-01",
      changes: ["Initial release"],
    };
    expect(entry.version).toBe("1.0.0");
    expect(entry.date).toBe("2026-03-01");
    expect(entry.changes).toHaveLength(1);
  });

  it("accepts multiple changes", () => {
    const entry: ChangelogEntry = {
      version: "1.1.0",
      date: "2026-03-15",
      changes: ["Added feature A", "Fixed bug B", "Improved performance"],
    };
    expect(entry.changes).toHaveLength(3);
  });

  it("accepts empty changes array", () => {
    const entry: ChangelogEntry = {
      version: "1.0.0",
      date: "2026-03-01",
      changes: [],
    };
    expect(entry.changes).toHaveLength(0);
  });
});

// =====================================================================
// Suite 3: RegistryPlugin type validation
// =====================================================================

describe("RegistryPlugin type", () => {
  it("accepts a minimal registry plugin (without optional fields)", () => {
    const plugin: RegistryPlugin = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      author: "Test",
      downloadUrl: "https://example.com/plugin.tgz",
    };
    expect(plugin.id).toBe("test-plugin");
    expect(plugin.icon).toBeUndefined();
    expect(plugin.category).toBeUndefined();
    expect(plugin.changelog).toBeUndefined();
  });

  it("accepts a full registry plugin with all optional fields", () => {
    const plugin: RegistryPlugin = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      author: "Test",
      icon: "<svg></svg>",
      category: "Utilities",
      downloadUrl: "https://example.com/plugin.tgz",
      minAppVersion: "0.3.0",
      permissions: ["clipboard.read", "storage"],
      changelog: [
        { version: "1.0.0", date: "2026-03-01", changes: ["Initial release"] },
      ],
    };
    expect(plugin.changelog).toHaveLength(1);
    expect(plugin.permissions).toContain("clipboard.read");
  });

  it("changelog field is properly optional", () => {
    const pluginWithout: RegistryPlugin = {
      id: "a", name: "A", version: "1.0.0",
      description: "desc", author: "auth",
      downloadUrl: "https://example.com/a.tgz",
    };
    const pluginWith: RegistryPlugin = {
      ...pluginWithout,
      changelog: [{ version: "1.0.0", date: "2026-01-01", changes: ["init"] }],
    };
    expect(pluginWithout.changelog).toBeUndefined();
    expect(pluginWith.changelog).toBeDefined();
  });
});

// =====================================================================
// Suite 4: Registry JSON parsing simulation
// =====================================================================

describe("Registry JSON parsing", () => {
  it("parses a v2 registry with changelog fields", () => {
    const json = JSON.stringify({
      version: 2,
      plugins: [
        {
          id: "hermes-hq.json-formatter",
          name: "JSON Formatter",
          version: "1.0.0",
          description: "Format JSON",
          author: "Hermes IDE",
          downloadUrl: "https://example.com/jf.tgz",
          changelog: [
            { version: "1.0.0", date: "2026-03-01", changes: ["Initial release"] },
          ],
        },
      ],
    });

    const data = JSON.parse(json);
    expect(data.version).toBe(2);
    const plugins: RegistryPlugin[] = data.plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].changelog).toBeDefined();
    expect(plugins[0].changelog![0].changes[0]).toBe("Initial release");
  });

  it("parses a v1 registry without changelog fields (backward compatible)", () => {
    const json = JSON.stringify({
      version: 1,
      plugins: [
        {
          id: "hermes-hq.json-formatter",
          name: "JSON Formatter",
          version: "1.0.0",
          description: "Format JSON",
          author: "Hermes IDE",
          downloadUrl: "https://example.com/jf.tgz",
        },
      ],
    });

    const data = JSON.parse(json);
    const plugins: RegistryPlugin[] = data.plugins;
    expect(plugins[0].changelog).toBeUndefined();
  });

  it("handles multiple changelog entries sorted by version", () => {
    const plugin: RegistryPlugin = {
      id: "test", name: "Test", version: "1.2.0",
      description: "d", author: "a",
      downloadUrl: "https://example.com/t.tgz",
      changelog: [
        { version: "1.2.0", date: "2026-03-20", changes: ["Feature C"] },
        { version: "1.1.0", date: "2026-03-10", changes: ["Feature B"] },
        { version: "1.0.0", date: "2026-03-01", changes: ["Feature A"] },
      ],
    };
    expect(plugin.changelog![0].version).toBe("1.2.0");
    expect(plugin.changelog![2].version).toBe("1.0.0");
  });
});
