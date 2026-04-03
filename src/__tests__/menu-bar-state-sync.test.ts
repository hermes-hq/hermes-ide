/**
 * Tests for menu state synchronization.
 *
 * - Correct menu item IDs used for state sync
 * - All toggle states are tracked
 * - API module structure
 * - Bridge module singleton pattern
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

// ─── Menu API Module ────────────────────────────────────────────────

describe("menu API module", () => {
  it("exports showContextMenu function", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export function showContextMenu");
  });

  it("exports updateMenuState function", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export function updateMenuState");
  });

  it("exports ContextMenuItem type", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export interface ContextMenuItem");
  });

  it("exports MenuItemUpdate type", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export interface MenuItemUpdate");
  });

  it("exports separator helper", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export function separator");
  });

  it("exports menuItem helper", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain("export function menuItem");
  });

  it("invokes show_context_menu command", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain('"show_context_menu"');
  });

  it("invokes update_menu_state command", () => {
    const src = readSrc("api/menu.ts");
    expect(src).toContain('"update_menu_state"');
  });
});

// ─── Menu State Sync Hook ───────────────────────────────────────────

describe("useMenuStateSync", () => {
  it("syncs sidebar visibility", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).toContain('"view.toggle-sidebar"');
    expect(src).toContain("sidebarVisible");
  });

  it("syncs process panel state", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).toContain('"view.process-panel"');
    expect(src).toContain("processPanelOpen");
  });

  it("syncs git panel state", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).toContain('"view.git-panel"');
    expect(src).toContain("gitPanelOpen");
  });

  it("syncs context panel state", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).toContain('"view.context-panel"');
    expect(src).toContain("contextPanelOpen");
  });

  it("syncs flow mode state", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).toContain('"view.flow-mode"');
    expect(src).toContain("flowMode");
  });
});

// ─── Native Menu Bridge Module ──────────────────────────────────────

describe("nativeMenuBridge", () => {
  it("exports ensureListener function", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    expect(src).toContain("export function ensureListener");
  });

  it("exports registerMenuBarHandler function", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    expect(src).toContain("export function registerMenuBarHandler");
  });

  it("exports registerContextMenuHandler function", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    expect(src).toContain("export function registerContextMenuHandler");
  });

  it("listens for menu-action events", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    expect(src).toContain('"menu-action"');
  });
});
