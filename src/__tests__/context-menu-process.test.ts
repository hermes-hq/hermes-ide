/**
 * Tests for process context menu migration.
 *
 * - Menu builder with protected/non-protected processes
 * - Advanced mode toggle effect
 * - Reveal in Finder conditional
 * - Source invariants
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
import { buildProcessMenuItems } from "../hooks/useContextMenu";

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

function findItem(items: { id: string }[], id: string) {
  return items.find((i) => i.id === id);
}

// ─── Process Menu Builder ───────────────────────────────────────────

describe("process context menu", () => {
  it("non-protected, normal mode: Copy PID + SIGTERM", () => {
    const items = buildProcessMenuItems({ pid: 100, is_protected: false }, false);
    expect(findItem(items, "process.copy-pid")).toBeDefined();
    expect(findItem(items, "process.sigterm")).toBeDefined();
    expect(findItem(items, "process.sigterm")!.enabled).toBe(true);
  });

  it("protected process: SIGTERM disabled", () => {
    const items = buildProcessMenuItems({ pid: 1, is_protected: true }, false);
    expect(findItem(items, "process.sigterm")!.enabled).toBe(false);
  });

  it("non-protected, advanced mode: includes SIGKILL and Kill Tree", () => {
    const items = buildProcessMenuItems({ pid: 100, is_protected: false }, true);
    expect(findItem(items, "process.sigkill")).toBeDefined();
    expect(findItem(items, "process.sigkill")!.enabled).toBe(true);
    expect(findItem(items, "process.kill-tree")).toBeDefined();
    expect(findItem(items, "process.kill-tree")!.enabled).toBe(true);
  });

  it("protected, advanced mode: SIGKILL and Kill Tree disabled", () => {
    const items = buildProcessMenuItems({ pid: 1, is_protected: true }, true);
    expect(findItem(items, "process.sigkill")!.enabled).toBe(false);
    expect(findItem(items, "process.kill-tree")!.enabled).toBe(false);
  });

  it("normal mode: no SIGKILL or Kill Tree", () => {
    const items = buildProcessMenuItems({ pid: 100, is_protected: false }, false);
    expect(findItem(items, "process.sigkill")).toBeUndefined();
    expect(findItem(items, "process.kill-tree")).toBeUndefined();
  });

  it("with exe_path: includes Reveal in Finder", () => {
    const items = buildProcessMenuItems(
      { pid: 100, is_protected: false, exe_path: "/usr/bin/node" },
      false,
    );
    expect(findItem(items, "process.reveal")).toBeDefined();
  });

  it("without exe_path: no Reveal in Finder", () => {
    const items = buildProcessMenuItems({ pid: 100, is_protected: false }, false);
    expect(findItem(items, "process.reveal")).toBeUndefined();
  });

  it("with exe_path has separator before Reveal", () => {
    const items = buildProcessMenuItems(
      { pid: 100, is_protected: false, exe_path: "/usr/bin/node" },
      false,
    );
    const revealIdx = items.findIndex((i) => i.id === "process.reveal");
    expect(items[revealIdx - 1].is_separator).toBe(true);
  });

  it("Copy PID is always the first item", () => {
    const items = buildProcessMenuItems({ pid: 100, is_protected: false }, true);
    expect(items[0].id).toBe("process.copy-pid");
  });

  it("Copy PID is always enabled even for protected processes", () => {
    const items = buildProcessMenuItems({ pid: 1, is_protected: true }, true);
    expect(findItem(items, "process.copy-pid")!.enabled).toBe(true);
  });
});

// ─── Source Invariants ──────────────────────────────────────────────

describe("process context menu migration", () => {
  it("ProcessPanel uses useContextMenu hook", () => {
    const src = readSrc("components/ProcessPanel.tsx");
    expect(src).toContain("useContextMenu");
  });

  it("ProcessPanel uses buildProcessMenuItems", () => {
    const src = readSrc("components/ProcessPanel.tsx");
    expect(src).toContain("buildProcessMenuItems");
  });
});
