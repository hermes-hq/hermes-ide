/**
 * Tests for global context menu suppression and architectural invariants.
 *
 * - Capture-phase listener prevents browser context menu
 * - Components with custom menus call stopPropagation
 * - No div-based context menus remain in the codebase
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = resolve(__dirname, "..");

function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

// ─── Global Suppression ─────────────────────────────────────────────

describe("global contextmenu suppression", () => {
  it("App.tsx registers a capture-phase contextmenu listener", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain('addEventListener("contextmenu"');
    // Must be capture phase (third arg = true)
    expect(src).toMatch(/addEventListener\("contextmenu".*true\)/s);
  });

  it("App.tsx calls preventDefault in the suppression handler", () => {
    const src = readSrc("App.tsx");
    // The handler should call preventDefault
    expect(src).toMatch(/contextmenu.*preventDefault/s);
  });

  it("the global listener is cleaned up on unmount", () => {
    const src = readSrc("App.tsx");
    expect(src).toContain('removeEventListener("contextmenu"');
  });
});

// ─── stopPropagation Guards ─────────────────────────────────────────

describe("stopPropagation in components with custom menus", () => {
  it("useContextMenu hook calls stopPropagation", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    expect(src).toContain("stopPropagation");
  });

  it("useTextContextMenu hook calls stopPropagation", () => {
    const src = readSrc("hooks/useTextContextMenu.ts");
    expect(src).toContain("stopPropagation");
  });

  it("useContextMenu hook calls preventDefault", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    expect(src).toContain("preventDefault");
  });
});

// ─── No Div-based Context Menus Remain ──────────────────────────────

describe("no div-based context menus remain", () => {
  it("SessionContextMenu.tsx has been deleted", () => {
    expect(() => readSrc("components/SessionContextMenu.tsx")).toThrow();
  });

  it("SessionList.tsx does not import SessionContextMenu", () => {
    const src = readSrc("components/SessionList.tsx");
    expect(src).not.toContain("SessionContextMenu");
  });

  it("ProcessPanel.tsx does not contain ProcessContextMenu component", () => {
    const src = readSrc("components/ProcessPanel.tsx");
    expect(src).not.toContain("function ProcessContextMenu");
  });

  it("SessionList.css has no .session-context-menu rules", () => {
    const src = readSrc("styles/components/SessionList.css");
    expect(src).not.toContain(".session-context-menu {");
    expect(src).not.toContain(".session-context-menu-item");
  });

  it("ProcessPanel.css has no .process-context-menu rules", () => {
    const src = readSrc("styles/components/ProcessPanel.css");
    expect(src).not.toContain(".process-context-menu");
    expect(src).not.toContain(".process-context-item");
  });
});
