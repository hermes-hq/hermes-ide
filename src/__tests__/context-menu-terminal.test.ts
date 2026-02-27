/**
 * Tests for terminal context menu specifics.
 *
 * - Terminal menu item structure
 * - Copy behavior with/without selection
 * - Split actions in menu
 * - Accelerator hints present
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
import { buildTerminalMenuItems } from "../hooks/useContextMenu";

// ─── Tests ──────────────────────────────────────────────────────────

describe("terminal context menu", () => {
  it("Copy has Cmd+C accelerator", () => {
    const items = buildTerminalMenuItems(true);
    const copy = items.find((i) => i.id === "terminal.copy");
    expect(copy?.accelerator).toBe("CmdOrCtrl+C");
  });

  it("Paste has Cmd+V accelerator", () => {
    const items = buildTerminalMenuItems(false);
    const paste = items.find((i) => i.id === "terminal.paste");
    expect(paste?.accelerator).toBe("CmdOrCtrl+V");
  });

  it("Split Right has Cmd+D accelerator", () => {
    const items = buildTerminalMenuItems(false);
    const split = items.find((i) => i.id === "terminal.split-right");
    expect(split?.accelerator).toBe("CmdOrCtrl+D");
  });

  it("Split Down has Cmd+Shift+D accelerator", () => {
    const items = buildTerminalMenuItems(false);
    const split = items.find((i) => i.id === "terminal.split-down");
    expect(split?.accelerator).toBe("CmdOrCtrl+Shift+D");
  });

  it("Clear Terminal has Cmd+L accelerator", () => {
    const items = buildTerminalMenuItems(false);
    const clear = items.find((i) => i.id === "terminal.clear");
    expect(clear?.accelerator).toBe("CmdOrCtrl+L");
  });

  it("items are grouped by separators: clipboard, text, splits, search", () => {
    const items = buildTerminalMenuItems(true);
    const seps = items.reduce<number[]>((acc, item, idx) => {
      if (item.is_separator) acc.push(idx);
      return acc;
    }, []);
    // Should have at least 3 separators creating 4 groups
    expect(seps.length).toBeGreaterThanOrEqual(3);
  });

  it("Select All is always enabled", () => {
    const items = buildTerminalMenuItems(false);
    const selectAll = items.find((i) => i.id === "terminal.select-all");
    expect(selectAll).toBeDefined();
    expect(selectAll!.enabled).toBe(true);
  });

  it("Reset Terminal is always enabled", () => {
    const items = buildTerminalMenuItems(false);
    const reset = items.find((i) => i.id === "terminal.reset");
    expect(reset).toBeDefined();
    expect(reset!.enabled).toBe(true);
  });

  it("all non-separator items have an id", () => {
    const items = buildTerminalMenuItems(true);
    for (const item of items) {
      if (!item.is_separator) {
        expect(item.id).toBeTruthy();
      }
    }
  });

  it("all non-separator items have a label", () => {
    const items = buildTerminalMenuItems(true);
    for (const item of items) {
      if (!item.is_separator) {
        expect(item.label).toBeTruthy();
      }
    }
  });

  it("no duplicate IDs", () => {
    const items = buildTerminalMenuItems(true);
    const ids = items.filter((i) => !i.is_separator).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Copy disabled implies selection-dependent behavior", () => {
    const withoutSelection = buildTerminalMenuItems(false);
    const withSelection = buildTerminalMenuItems(true);
    const copyDisabled = withoutSelection.find((i) => i.id === "terminal.copy");
    const copyEnabled = withSelection.find((i) => i.id === "terminal.copy");
    expect(copyDisabled!.enabled).toBe(false);
    expect(copyEnabled!.enabled).toBe(true);
  });

  it("Find has Cmd+Shift+F accelerator", () => {
    const items = buildTerminalMenuItems(false);
    const find = items.find((i) => i.id === "terminal.search");
    expect(find?.accelerator).toBe("CmdOrCtrl+Shift+F");
  });
});
