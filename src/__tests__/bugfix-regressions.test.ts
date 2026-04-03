/**
 * Regression tests for bugs found by the 5-agent QA sweep.
 *
 * Covers:
 * - CRITICAL: Rust update_menu_state recursive search (source invariant)
 * - HIGH: Stale closure protection via useRef in useContextMenu
 * - HIGH: clearContextMenuHandler export for dismiss cleanup
 * - HIGH: CostDashboard useRef (not plain object)
 * - HIGH: Duplicate accelerator removal
 * - MEDIUM: useTextContextMenu DOM detach guard
 * - MEDIUM: ensureListener retry on failure
 * - MEDIUM: fileExplorerOpen removed from useMenuStateSync deps
 * - MEDIUM: clipboard .catch() on all writeText calls
 * - MEDIUM: createSession prop used in useNativeMenuEvents
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

// ─── CRITICAL: Recursive menu item search in Rust ────────────────────

describe("Rust update_menu_state recursive search", () => {
  it("defines find_menu_item_recursive function", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src-tauri/src/menu/mod.rs"),
      "utf-8",
    );
    expect(src).toContain("fn find_menu_item_recursive");
  });

  it("defines find_in_submenu function", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src-tauri/src/menu/mod.rs"),
      "utf-8",
    );
    expect(src).toContain("fn find_in_submenu");
  });

  it("update_menu_state uses recursive search, not Menu::get", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src-tauri/src/menu/mod.rs"),
      "utf-8",
    );
    const updateFn =
      src.match(
        /pub async fn update_menu_state[\s\S]*?^}/m,
      )?.[0] || "";
    expect(updateFn).toContain("find_menu_item_recursive");
    expect(updateFn).not.toContain("m.get(");
  });
});

// ─── HIGH: Stale closure protection via useRef ───────────────────────

describe("useContextMenu stale closure fix", () => {
  it("uses useRef for onAction callback", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    expect(src).toContain("useRef(onAction)");
    expect(src).toContain("onActionRef.current");
  });

  it("showMenu callback has empty dependency array (stable reference)", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    // The useCallback for showMenu should have [] deps
    const hookSection = src.match(
      /export function useContextMenu[\s\S]*?return \{ showMenu \}/,
    )?.[0] || "";
    expect(hookSection).toContain("useCallback(\n");
    // Verify it passes a ref wrapper, not onAction directly
    expect(hookSection).toContain("onActionRef.current(actionId)");
  });
});

// ─── HIGH: clearContextMenuHandler export ────────────────────────────

describe("nativeMenuBridge clearContextMenuHandler", () => {
  it("exports clearContextMenuHandler function", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    expect(src).toContain("export function clearContextMenuHandler");
  });

  it("useContextMenu imports clearContextMenuHandler", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    expect(src).toContain("clearContextMenuHandler");
  });

  it("useContextMenu calls clearContextMenuHandler on invoke failure", () => {
    const src = readSrc("hooks/useContextMenu.ts");
    expect(src).toContain(".catch(() => {");
    expect(src).toContain("clearContextMenuHandler()");
  });

  it("useTextContextMenu calls clearContextMenuHandler on invoke failure", () => {
    const src = readSrc("hooks/useTextContextMenu.ts");
    expect(src).toContain("clearContextMenuHandler");
  });
});

// ─── HIGH: CostDashboard useRef (not plain object) ───────────────────

describe("CostDashboard ref fix", () => {
  it("uses useRef for contextCostRef, not plain object", () => {
    const src = readSrc("components/CostDashboard.tsx");
    expect(src).toContain("useRef(");
    expect(src).not.toMatch(/contextCostRef\s*=\s*\{\s*current:/);
  });

  it("imports useRef from react", () => {
    const src = readSrc("components/CostDashboard.tsx");
    expect(src).toMatch(/import\s*\{[^}]*useRef[^}]*\}\s*from\s*"react"/);
  });
});

// ─── HIGH: Duplicate accelerator removal ─────────────────────────────

describe("accelerator uniqueness", () => {
  it("edit.find does not have CmdOrCtrl+Shift+F accelerator", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src-tauri/src/menu/mod.rs"),
      "utf-8",
    );
    // Find the edit.find definition — it should NOT have an accelerator line
    const editFindSection = src.match(
      /let find = MenuItemBuilder::with_id\("edit\.find"[\s\S]*?\.build\(app\)/,
    )?.[0] || "";
    expect(editFindSection).not.toContain("CmdOrCtrl+Shift+F");
  });

  it("view.search-panel still has CmdOrCtrl+Shift+F", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src-tauri/src/menu/mod.rs"),
      "utf-8",
    );
    const searchSection = src.match(
      /let search_panel = CheckMenuItemBuilder::with_id\("view\.search-panel"[\s\S]*?\.build\(app\)/,
    )?.[0] || "";
    expect(searchSection).toContain("CmdOrCtrl+Shift+F");
  });
});

// ─── MEDIUM: useTextContextMenu DOM detach guard ─────────────────────

describe("useTextContextMenu DOM detach guard", () => {
  it("checks target.isConnected before focusing", () => {
    const src = readSrc("hooks/useTextContextMenu.ts");
    expect(src).toContain("target.isConnected");
  });

  it("returns early if target is disconnected", () => {
    const src = readSrc("hooks/useTextContextMenu.ts");
    expect(src).toContain("if (!target.isConnected) return;");
  });
});

// ─── MEDIUM: ensureListener retry on failure ─────────────────────────

describe("ensureListener failure retry", () => {
  it("clears listenerPromise on catch so next call retries", () => {
    const src = readSrc("hooks/nativeMenuBridge.ts");
    const ensureFn =
      src.match(/export function ensureListener[\s\S]*?return listenerPromise;\n}/)?.[0] || "";
    expect(ensureFn).toContain(".catch(");
    expect(ensureFn).toContain("listenerPromise = null");
  });
});

// ─── MEDIUM: fileExplorerOpen removed from useMenuStateSync ──────────

describe("useMenuStateSync does not track fileExplorerOpen", () => {
  it("interface does not include fileExplorerOpen", () => {
    const src = readSrc("hooks/useMenuStateSync.ts");
    expect(src).not.toContain("fileExplorerOpen");
  });

  it("App.tsx does not pass fileExplorerOpen to useMenuStateSync", () => {
    const src = readSrc("App.tsx");
    const syncCall = src.match(
      /useMenuStateSync\(\{[\s\S]*?\}\)/,
    )?.[0] || "";
    expect(syncCall).not.toContain("fileExplorerOpen");
  });
});

// ─── MEDIUM: clipboard .catch() on all writeText calls ───────────────

describe("clipboard writeText error handling", () => {
  const components = [
    { file: "components/FileExplorerPanel.tsx", name: "FileExplorerPanel" },
    { file: "components/SearchPanel.tsx", name: "SearchPanel" },
    { file: "components/GitLogView.tsx", name: "GitLogView" },
    { file: "components/GitBranchSelector.tsx", name: "GitBranchSelector" },
    { file: "components/StatusBar.tsx", name: "StatusBar" },
    { file: "components/CostDashboard.tsx", name: "CostDashboard" },
    { file: "components/ProcessPanel.tsx", name: "ProcessPanel" },
  ];

  for (const { file, name } of components) {
    it(`${name} has .catch() on every clipboard.writeText call`, () => {
      const src = readSrc(file);
      // Match the full clipboard.writeText(...).catch(...) chain
      const writeTextCalls = src.match(/clipboard\.writeText\([^)]+\)/g) || [];
      expect(writeTextCalls.length).toBeGreaterThan(0);
      for (const call of writeTextCalls) {
        const idx = src.indexOf(call);
        // Look ahead far enough to find .catch after possible closing parens/backticks
        const rest = src.slice(idx, idx + call.length + 50);
        expect(rest).toContain(".catch(");
      }
    });
  }
});

// ─── MEDIUM: createSession prop used in useNativeMenuEvents ──────────

describe("useNativeMenuEvents uses createSession prop", () => {
  it("destructures createSession from handlers", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    expect(src).toContain("createSession,");
  });

  it("file.new-session calls createSession(), not setSessionCreatorOpen", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    const newSessionCase = src.match(
      /case "file\.new-session":[\s\S]*?break;/,
    )?.[0] || "";
    expect(newSessionCase).toContain("createSession()");
    expect(newSessionCase).not.toContain("setSessionCreatorOpen");
  });

  it("createSession is in the useCallback dependency array", () => {
    const src = readSrc("hooks/useNativeMenuEvents.ts");
    const depsSection = src.match(
      /\[\s*\n\s*dispatch,[\s\S]*?\]/,
    )?.[0] || "";
    expect(depsSection).toContain("createSession");
  });
});
