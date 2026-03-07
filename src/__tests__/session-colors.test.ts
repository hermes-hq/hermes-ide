/**
 * Tests for session/project color system.
 *
 * Covers: SESSION_COLORS palette, color-related exports,
 * CreateSessionOpts color field, and drag encode/decode helpers.
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

import { SESSION_COLORS } from "../components/SessionList";
import {
  encodeSessionDrag,
  decodeSessionDrag,
  setDraggedSession,
  getDraggedSession,
} from "../components/SplitPane";

// ─── SESSION_COLORS palette ──────────────────────────────────────────

describe("SESSION_COLORS", () => {
  it("contains exactly 12 colors", () => {
    expect(SESSION_COLORS).toHaveLength(12);
  });

  it("all entries are valid hex color strings", () => {
    for (const c of SESSION_COLORS) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("has no duplicate colors", () => {
    const unique = new Set(SESSION_COLORS.map((c) => c.toLowerCase()));
    expect(unique.size).toBe(SESSION_COLORS.length);
  });
});

// ─── Drag encode/decode helpers ──────────────────────────────────────

describe("encodeSessionDrag / decodeSessionDrag", () => {
  it("round-trips a session id", () => {
    const id = "abc-123";
    const encoded = encodeSessionDrag(id);
    expect(decodeSessionDrag(encoded)).toBe(id);
  });

  it("returns null for non-prefixed data", () => {
    expect(decodeSessionDrag("random-text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeSessionDrag("")).toBeNull();
  });

  it("handles empty session id after prefix", () => {
    const encoded = encodeSessionDrag("");
    expect(decodeSessionDrag(encoded)).toBe("");
  });
});

// ─── Shared drag state ──────────────────────────────────────────────

describe("setDraggedSession / getDraggedSession", () => {
  it("stores and retrieves a session id", () => {
    setDraggedSession("sess-1");
    expect(getDraggedSession()).toBe("sess-1");
  });

  it("clears with null", () => {
    setDraggedSession("sess-1");
    setDraggedSession(null);
    expect(getDraggedSession()).toBeNull();
  });
});

// ─── CreateSessionOpts color field ──────────────────────────────────

describe("CreateSessionOpts type", () => {
  it("accepts color as optional string (type-level check)", () => {
    // This is a compile-time check — if color were removed from the type,
    // this file would fail to compile.
    const opts: import("../types/session").CreateSessionOpts = {
      label: "test",
      color: "#58a6ff",
      group: "my-project",
    };
    expect(opts.color).toBe("#58a6ff");
  });

  it("defaults color to undefined when not provided", () => {
    const opts: import("../types/session").CreateSessionOpts = {
      label: "test",
    };
    expect(opts.color).toBeUndefined();
  });
});
