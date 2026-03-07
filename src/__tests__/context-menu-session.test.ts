/**
 * Tests for session context menu migration.
 *
 * - Session menu builder correctness
 * - Empty area fallback menu
 * - Group submenu structure
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
import { buildSessionMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

// ─── Session Menu Builder ───────────────────────────────────────────

describe("session context menu", () => {
  it("Rename is always the first action", () => {
    const items = buildSessionMenuItems({ id: "s1", group: null, phase: "idle" }, []);
    expect(items[0].id).toBe("session.rename");
  });

  it("Close is always the last action", () => {
    const items = buildSessionMenuItems({ id: "s1", group: null, phase: "idle" }, []);
    const nonSep = items.filter((i) => !i.is_separator);
    expect(nonSep[nonSep.length - 1].id).toBe("session.close");
  });

  it("group submenu items use 'session.set-group.<name>' ID pattern", () => {
    const items = buildSessionMenuItems({ id: "s1", group: null, phase: "idle" }, ["dev", "staging"]);
    const groupSub = items.find((i) => i.label === "Project");
    expect(groupSub).toBeDefined();
    const groupItems = groupSub!.children!.filter((c: { is_separator?: boolean }) => !c.is_separator);
    const setGroupItems = groupItems.filter((c: { id: string }) => c.id.startsWith("session.set-group."));
    expect(setGroupItems.length).toBe(2);
    expect(setGroupItems[0].id).toBe("session.set-group.dev");
    expect(setGroupItems[1].id).toBe("session.set-group.staging");
  });

  it("group submenu always includes New Group", () => {
    const items = buildSessionMenuItems({ id: "s1", group: null, phase: "idle" }, ["dev"]);
    const groupSub = items.find((i) => i.label === "Project");
    const newGroup = groupSub!.children!.find((c: { id: string }) => c.id === "session.new-group");
    expect(newGroup).toBeDefined();
  });

  it("no group submenu when no groups — shows flat New Group instead", () => {
    const items = buildSessionMenuItems({ id: "s1", group: null, phase: "idle" }, []);
    const groupSub = items.find((i) => i.label === "Project");
    expect(groupSub).toBeUndefined();
    const newGroup = items.find((i) => i.id === "session.new-group");
    expect(newGroup).toBeDefined();
  });
});

// ─── Empty Area Fallback ────────────────────────────────────────────

describe("session list empty area menu", () => {
  it("sidebar empty area includes New Session", () => {
    const items = buildEmptyAreaMenuItems("sidebar");
    expect(items.find((i) => i.id === "empty.new-session")).toBeDefined();
  });

  it("New Session has Cmd+N accelerator", () => {
    const items = buildEmptyAreaMenuItems("sidebar");
    const newSession = items.find((i) => i.id === "empty.new-session");
    expect(newSession?.accelerator).toBe("CmdOrCtrl+N");
  });
});

// ─── Migration Invariants ───────────────────────────────────────────

describe("session context menu migration", () => {
  it("SessionList uses useContextMenu hook", () => {
    const src = readSrc("components/SessionList.tsx");
    expect(src).toContain("useContextMenu");
  });

  it("SessionList uses buildSessionMenuItems", () => {
    const src = readSrc("components/SessionList.tsx");
    expect(src).toContain("buildSessionMenuItems");
  });

  it("SessionList has inline rename input for Rename action", () => {
    const src = readSrc("components/SessionList.tsx");
    expect(src).toContain("renameSessionId");
  });

  it("SessionList has inline input for New Group action", () => {
    const src = readSrc("components/SessionList.tsx");
    expect(src).toContain("newGroupSessionId");
  });
});
