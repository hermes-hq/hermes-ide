/**
 * Tests for menu bar event → React action mapping.
 *
 * - Every menu action ID maps to a correct handler call
 * - Keyboard shortcut migration: no duplicate handlers
 * - Source invariants for menu integration
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
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
  sendShortcutCommand: vi.fn(),
  focusTerminal: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

// ─── Menu Event Bridge Source Tests ─────────────────────────────────

describe("menu bar integration", () => {
  it("App.tsx imports useNativeMenuEvents", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain('import { useNativeMenuEvents }');
  });

  it("App.tsx imports useMenuStateSync", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain('import { useMenuStateSync }');
  });

  it("App.tsx calls useNativeMenuEvents in AppContent", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain("useNativeMenuEvents(");
  });

  it("App.tsx calls useMenuStateSync in AppContent", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain("useMenuStateSync(");
  });
});

// ─── Keyboard Handler Migration ─────────────────────────────────────

describe("keyboard handler migration", () => {
  it("App.tsx no longer handles Cmd+N directly (handled by menu bar)", () => {
    const src = readSrc("App.tsx");
    // The keyboard handler should NOT contain 'case "n"' for Cmd+N
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"n"/);
  });

  it("App.tsx no longer handles Cmd+B directly", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"b"/);
  });

  it("App.tsx no longer handles Cmd+E directly", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"e"/);
  });

  it("App.tsx no longer handles Cmd+K directly", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"k"/);
  });

  it("App.tsx no longer handles Cmd+P directly", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"p"/);
  });

  it("App.tsx no longer handles Cmd+G directly", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).not.toMatch(/case\s+"g"/);
  });

  it("App.tsx still handles Cmd+Alt+Arrow for pane navigation", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain("ArrowRight");
    expect(src).toContain("ArrowLeft");
    expect(src).toContain("FOCUS_PANE");
  });

  it("App.tsx still handles Cmd+1-9 for session switching", () => {
    const src = readSrc("App.tsx");
    const keyboardSection = src.match(/Keyboard shortcuts.*?removeEventListener/s)?.[0] || "";
    expect(keyboardSection).toContain('"1"');
    expect(keyboardSection).toContain('"9"');
  });
});

// ─── useNativeMenuEvents Handler Coverage ───────────────────────────

describe("useNativeMenuEvents action mapping", () => {
  it("handles file.new-session", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"file.new-session"');
  });

  it("handles file.close-pane", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"file.close-pane"');
  });

  it("handles view.toggle-sidebar", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"view.toggle-sidebar"');
    expect(src).toContain("TOGGLE_SIDEBAR");
  });

  it("handles view.command-palette", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"view.command-palette"');
    expect(src).toContain("TOGGLE_PALETTE");
  });

  it("handles hermes.settings", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"hermes.settings"');
  });

  it("handles session.copy-context", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain('"session.copy-context"');
  });
});
