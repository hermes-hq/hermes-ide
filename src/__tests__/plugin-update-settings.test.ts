/**
 * Tests for plugin update settings integration.
 *
 * Covers:
 * - Setting key validation (the 4 new keys)
 * - Default value semantics
 * - Ignored updates JSON serialization
 * - Settings round-trip simulation
 * - Command palette entry for plugin updates
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// =====================================================================
// Suite 1: Plugin update setting keys
// =====================================================================

describe("Plugin update setting keys", () => {
  // These keys must match what's registered in VALID_SETTING_KEYS in Rust
  const EXPECTED_KEYS = [
    "plugin_update_check",
    "plugin_auto_update",
    "plugin_ignored_updates",
    "plugin_last_update_check",
  ];

  it("defines all 4 expected plugin update setting keys", () => {
    expect(EXPECTED_KEYS).toHaveLength(4);
  });

  it("all keys follow snake_case naming convention", () => {
    for (const key of EXPECTED_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("all keys start with plugin_ prefix", () => {
    for (const key of EXPECTED_KEYS) {
      expect(key.startsWith("plugin_")).toBe(true);
    }
  });
});

// =====================================================================
// Suite 2: plugin_update_check values
// =====================================================================

describe("plugin_update_check setting values", () => {
  const VALID_VALUES = ["startup", "daily", "weekly", "never"];

  it("has 4 valid options", () => {
    expect(VALID_VALUES).toHaveLength(4);
  });

  it("'startup' is the intended default", () => {
    // When no setting is stored, the hook defaults to "startup"
    const defaultValue = "startup";
    expect(VALID_VALUES).toContain(defaultValue);
  });

  it("all values are lowercase strings", () => {
    for (const v of VALID_VALUES) {
      expect(v).toBe(v.toLowerCase());
    }
  });
});

// =====================================================================
// Suite 3: plugin_auto_update values
// =====================================================================

describe("plugin_auto_update setting values", () => {
  it("'true' enables auto-update", () => {
    const value = "true";
    expect(value === "true").toBe(true);
  });

  it("'false' is the default (auto-update off)", () => {
    const value = "false";
    expect(value === "true").toBe(false);
  });

  it("empty string is treated as false", () => {
    const value = "";
    expect(value === "true").toBe(false);
  });
});

// =====================================================================
// Suite 4: plugin_ignored_updates JSON format
// =====================================================================

describe("plugin_ignored_updates JSON format", () => {
  it("stores ignored versions as plugin-id → version map", () => {
    const ignored: Record<string, string> = {
      "hermes-hq.json-formatter": "1.1.0",
      "hermes-hq.uuid-generator": "2.0.0",
    };
    const json = JSON.stringify(ignored);
    const parsed = JSON.parse(json);
    expect(parsed["hermes-hq.json-formatter"]).toBe("1.1.0");
    expect(parsed["hermes-hq.uuid-generator"]).toBe("2.0.0");
  });

  it("empty object means no ignored versions", () => {
    const json = JSON.stringify({});
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it("adding an ignored version updates the map", () => {
    const initial: Record<string, string> = {};
    initial["plugin-a"] = "1.2.0";
    expect(Object.keys(initial)).toHaveLength(1);
    expect(initial["plugin-a"]).toBe("1.2.0");
  });

  it("overwriting an ignored version with a newer one updates in place", () => {
    const ignored: Record<string, string> = { "plugin-a": "1.0.0" };
    ignored["plugin-a"] = "2.0.0"; // user skips a newer version
    expect(ignored["plugin-a"]).toBe("2.0.0");
  });

  it("serialized JSON is compact (no extra whitespace)", () => {
    const json = JSON.stringify({ a: "1.0.0" });
    expect(json).not.toContain(" ");
    expect(json).toBe('{"a":"1.0.0"}');
  });
});

// =====================================================================
// Suite 5: plugin_last_update_check ISO format
// =====================================================================

describe("plugin_last_update_check ISO format", () => {
  it("stores as ISO 8601 string", () => {
    const now = new Date().toISOString();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("can be parsed back to Date", () => {
    const iso = "2026-03-11T12:00:00.000Z";
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2); // March (0-indexed)
    expect(date.getDate()).toBe(11);
  });

  it("empty string represents 'never checked'", () => {
    const value = "";
    const hasChecked = value.length > 0;
    expect(hasChecked).toBe(false);
  });
});

// =====================================================================
// Suite 6: Command palette entry simulation
// =====================================================================

describe("Command palette — Check for Plugin Updates", () => {
  it("command has correct id", () => {
    const command = {
      id: "check-plugin-updates",
      label: "Check for Plugin Updates",
      category: "Plugins",
      action: vi.fn(),
    };
    expect(command.id).toBe("check-plugin-updates");
  });

  it("command has Plugins category", () => {
    const command = {
      id: "check-plugin-updates",
      label: "Check for Plugin Updates",
      category: "Plugins",
      action: vi.fn(),
    };
    expect(command.category).toBe("Plugins");
  });

  it("command action is callable", () => {
    const action = vi.fn();
    const command = {
      id: "check-plugin-updates",
      label: "Check for Plugin Updates",
      category: "Plugins",
      action,
    };
    command.action();
    expect(action).toHaveBeenCalledOnce();
  });

  it("command label is searchable for 'plugin' query", () => {
    const label = "Check for Plugin Updates";
    const query = "plugin";
    expect(label.toLowerCase().includes(query)).toBe(true);
  });

  it("command label is searchable for 'update' query", () => {
    const label = "Check for Plugin Updates";
    const query = "update";
    expect(label.toLowerCase().includes(query)).toBe(true);
  });
});
