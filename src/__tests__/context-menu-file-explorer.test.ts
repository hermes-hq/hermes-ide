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

describe("file explorer — file items", () => {
  const file = { name: "index.ts", is_dir: false, path: "/src/index.ts" };

  it("no New File or New Folder for files", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.new-file")).toBeUndefined();
    expect(findItem(items, "file-explorer.new-folder")).toBeUndefined();
  });

  it("includes Open in Terminal", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.open-terminal")).toBeDefined();
  });

  it("includes Rename", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.rename")).toBeDefined();
  });

  it("includes Delete", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.delete")).toBeDefined();
  });

  it("includes Copy Path", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.copy-path")).toBeDefined();
  });

  it("includes Reveal in Finder", () => {
    const items = buildFileExplorerMenuItems(file);
    expect(findItem(items, "file-explorer.reveal")).toBeDefined();
  });
});

describe("file explorer — folder items", () => {
  const folder = { name: "src", is_dir: true, path: "/src" };

  it("includes New File for folders", () => {
    const items = buildFileExplorerMenuItems(folder);
    expect(findItem(items, "file-explorer.new-file")).toBeDefined();
  });

  it("includes New Folder for folders", () => {
    const items = buildFileExplorerMenuItems(folder);
    expect(findItem(items, "file-explorer.new-folder")).toBeDefined();
  });

  it("New File and New Folder are before separator", () => {
    const items = buildFileExplorerMenuItems(folder);
    const newFileIdx = items.findIndex((i) => i.id === "file-explorer.new-file");
    const newFolderIdx = items.findIndex((i) => i.id === "file-explorer.new-folder");
    const firstSepIdx = items.findIndex((i) => i.is_separator);
    expect(newFileIdx).toBeLessThan(firstSepIdx);
    expect(newFolderIdx).toBeLessThan(firstSepIdx);
  });

  it("still includes Rename, Delete, Copy Path, Reveal", () => {
    const items = buildFileExplorerMenuItems(folder);
    expect(findItem(items, "file-explorer.rename")).toBeDefined();
    expect(findItem(items, "file-explorer.delete")).toBeDefined();
    expect(findItem(items, "file-explorer.copy-path")).toBeDefined();
    expect(findItem(items, "file-explorer.reveal")).toBeDefined();
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
