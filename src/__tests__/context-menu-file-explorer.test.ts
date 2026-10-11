/**
 * Tests for file explorer context menu.
 *
 * - File vs folder menu variants
 * - Empty area fallback menu
 * - Action item completeness
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

// ─── Imports ─────────────────────────────────────────────────────────
import { buildFileExplorerMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

function findItem(items: { id: string }[], id: string) {
  return items.find((i) => i.id === id);
}

// ─── File vs Folder Variants ────────────────────────────────────────

// Listed once but never carried out by FileExplorerPanel: choosing them
// closed the menu and did nothing.
const UNIMPLEMENTED = [
  "file-explorer.new-file",
  "file-explorer.new-folder",
  "file-explorer.open-terminal",
  "file-explorer.rename",
  "file-explorer.delete",
  "file-explorer.reveal",
];

describe("file explorer — file items", () => {
  const file = { name: "index.ts", is_dir: false, path: "/src/index.ts" };

  it("includes Open in Editor", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.open-in-editor")).toBeDefined();
  });

  it("includes Copy Path", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.copy-path")).toBeDefined();
  });

  it("offers no action that does nothing", () => {
    const items = buildFileExplorerMenuItems(file);
    for (const id of UNIMPLEMENTED) expect(findItem(items, id)).toBeUndefined();
  });
});

describe("file explorer — folder items", () => {
  const folder = { name: "src", is_dir: true, path: "/src" };

  it("includes Copy Path but not Open in Editor", () => {
    const items = buildFileExplorerMenuItems(folder);
    expect(findItem(items, "file-explorer.copy-path")).toBeDefined();
    expect(findItem(items, "file-explorer.open-in-editor")).toBeUndefined();
  });

  it("offers no action that does nothing", () => {
    const items = buildFileExplorerMenuItems(folder);
    for (const id of UNIMPLEMENTED) expect(findItem(items, id)).toBeUndefined();
  });
});

describe("file explorer — every offered item is handled", () => {
  it("FileExplorerPanel has a case for each item id", () => {
    const panel = readSrc("components/FileExplorerPanel.tsx");
    const ids = [
      ...buildFileExplorerMenuItems({ name: "a.ts", is_dir: false, path: "/a.ts" }),
      ...buildFileExplorerMenuItems({ name: "src", is_dir: true, path: "/src" }),
    ].filter((i) => !i.is_separator).map((i) => i.id);
    for (const id of ids) expect(panel).toContain(`case "${id}":`);
  });
});

// ─── Empty Area Fallback ────────────────────────────────────────────

describe("file explorer — empty area menu", () => {
  it("includes New File", () => {
    const items = buildEmptyAreaMenuItems("file-explorer");
    expect(findItem(items, "empty.new-file")).toBeDefined();
  });

  it("includes New Folder", () => {
    const items = buildEmptyAreaMenuItems("file-explorer");
    expect(findItem(items, "empty.new-folder")).toBeDefined();
  });

  it("includes Open Terminal Here", () => {
    const items = buildEmptyAreaMenuItems("file-explorer");
    expect(findItem(items, "empty.open-terminal")).toBeDefined();
  });

  it("has a separator between creation and terminal actions", () => {
    const items = buildEmptyAreaMenuItems("file-explorer");
    const seps = items.filter((i) => i.is_separator);
    expect(seps.length).toBeGreaterThanOrEqual(1);
  });
});
