/**
 * Tests for text input context menu (Category B).
 *
 * - Menu builder correctness
 * - Selection state detection
 * - Standard text operations
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
import { buildTextInputMenuItems } from "../hooks/useContextMenu";

function findItem(items: { id: string }[], id: string) {
  return items.find((i) => i.id === id);
}

// ─── Text Input Menu Builder ────────────────────────────────────────

describe("text input context menu", () => {
  it("Cut is disabled with no selection", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.cut")!.enabled).toBe(false);
  });

  it("Cut is enabled with selection", () => {
    const items = buildTextInputMenuItems(true);
    expect(findItem(items, "text.cut")!.enabled).toBe(true);
  });

  it("Copy is disabled with no selection", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.copy")!.enabled).toBe(false);
  });

  it("Copy is enabled with selection", () => {
    const items = buildTextInputMenuItems(true);
    expect(findItem(items, "text.copy")!.enabled).toBe(true);
  });

  it("Paste is always enabled", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.paste")!.enabled).toBe(true);
  });

  it("Select All is always enabled", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.select-all")!.enabled).toBe(true);
  });

  it("has correct accelerators", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.cut")!.accelerator).toBe("CmdOrCtrl+X");
    expect(findItem(items, "text.copy")!.accelerator).toBe("CmdOrCtrl+C");
    expect(findItem(items, "text.paste")!.accelerator).toBe("CmdOrCtrl+V");
    expect(findItem(items, "text.select-all")!.accelerator).toBe("CmdOrCtrl+A");
  });

  it("separator between clipboard and selection actions", () => {
    const items = buildTextInputMenuItems(false);
    const sepIdx = items.findIndex((i) => i.is_separator);
    expect(sepIdx).toBe(3); // After Cut, Copy, Paste
  });

  it("items: Cut, Copy, Paste, separator, Select All", () => {
    const items = buildTextInputMenuItems(true);
    expect(items[0].id).toBe("text.cut");
    expect(items[1].id).toBe("text.copy");
    expect(items[2].id).toBe("text.paste");
    expect(items[3].is_separator).toBe(true);
    expect(items[4].id).toBe("text.select-all");
  });

  it("consistent structure regardless of selection", () => {
    const withSel = buildTextInputMenuItems(true);
    const withoutSel = buildTextInputMenuItems(false);
    expect(withSel.length).toBe(withoutSel.length);
    for (let i = 0; i < withSel.length; i++) {
      expect(withSel[i].id).toBe(withoutSel[i].id);
      expect(withSel[i].label).toBe(withoutSel[i].label);
    }
  });

  it("no duplicate IDs", () => {
    const items = buildTextInputMenuItems(true);
    const ids = items.filter((i) => !i.is_separator).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
