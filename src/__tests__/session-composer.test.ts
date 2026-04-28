/**
 * Tests for the per-pane session composer feature.
 *
 * Covers:
 *   1. Reducer cases for SET_COMPOSER_DRAFT, SET_COMPOSER_HEIGHT, and the
 *      SESSION_REMOVED cleanup of the new `composers` slice.
 *   2. The submitToPty util that frames text as a bracketed paste and writes
 *      it to the PTY, including UTF-8 encoding and pre-write buffer clearing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/sessions", () => ({
  writeToSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../terminal/TerminalPool", () => ({
  dismissSuggestions: vi.fn(),
  clearGhostText: vi.fn(),
  getInputBufferLength: vi.fn().mockReturnValue(0),
  clearInputBuffer: vi.fn(),
}));

import { sessionReducer, initialState } from "../state/SessionContext";
import { submitToPty } from "../utils/submitToPty";
import { writeToSession } from "../api/sessions";
import {
  dismissSuggestions,
  clearGhostText,
  getInputBufferLength,
  clearInputBuffer,
} from "../terminal/TerminalPool";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Decode a base64 string back to its original byte sequence. */
function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Compare two byte arrays for exact equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Reducer tests ───────────────────────────────────────────────────

describe("session composer reducer", () => {
  it("SET_COMPOSER_DRAFT creates a new entry with default height + collapsed when none exists", () => {
    const next = sessionReducer(initialState, {
      type: "SET_COMPOSER_DRAFT",
      sessionId: "s1",
      draft: "hello",
    });
    expect(next.composers["s1"]).toEqual({ draft: "hello", height: 120, expanded: false });
  });

  it("SET_COMPOSER_DRAFT preserves the existing height and expanded flag", () => {
    const seeded = {
      ...initialState,
      composers: {
        s1: { draft: "old", height: 240, expanded: true },
      },
    };
    const next = sessionReducer(seeded, {
      type: "SET_COMPOSER_DRAFT",
      sessionId: "s1",
      draft: "new",
    });
    expect(next.composers["s1"]).toEqual({ draft: "new", height: 240, expanded: true });
  });

  it("SET_COMPOSER_DRAFT for one session does not touch other sessions' composers", () => {
    const seeded = {
      ...initialState,
      composers: {
        s1: { draft: "a", height: 200, expanded: false },
        s2: { draft: "b", height: 300, expanded: true },
      },
    };
    const next = sessionReducer(seeded, {
      type: "SET_COMPOSER_DRAFT",
      sessionId: "s1",
      draft: "updated",
    });
    expect(next.composers["s1"]).toEqual({ draft: "updated", height: 200, expanded: false });
    expect(next.composers["s2"]).toBe(seeded.composers["s2"]);
    expect(next.composers["s2"]).toEqual({ draft: "b", height: 300, expanded: true });
  });

  it("SET_COMPOSER_HEIGHT creates a new entry with default draft when none exists", () => {
    const next = sessionReducer(initialState, {
      type: "SET_COMPOSER_HEIGHT",
      sessionId: "s1",
      height: 400,
    });
    expect(next.composers["s1"]).toEqual({ draft: "", height: 400, expanded: false });
  });

  it("SET_COMPOSER_HEIGHT preserves the existing draft", () => {
    const seeded = {
      ...initialState,
      composers: {
        s1: { draft: "important text", height: 120, expanded: false },
      },
    };
    const next = sessionReducer(seeded, {
      type: "SET_COMPOSER_HEIGHT",
      sessionId: "s1",
      height: 500,
    });
    expect(next.composers["s1"]).toEqual({ draft: "important text", height: 500, expanded: false });
  });

  it("TOGGLE_COMPOSER_EXPANDED flips the expanded flag and creates a default entry if missing", () => {
    const fromMissing = sessionReducer(initialState, {
      type: "TOGGLE_COMPOSER_EXPANDED",
      sessionId: "s1",
    });
    expect(fromMissing.composers["s1"]).toEqual({ draft: "", height: 120, expanded: true });

    const seeded = {
      ...initialState,
      composers: { s1: { draft: "wip", height: 220, expanded: true } },
    };
    const flipped = sessionReducer(seeded, {
      type: "TOGGLE_COMPOSER_EXPANDED",
      sessionId: "s1",
    });
    expect(flipped.composers["s1"]).toEqual({ draft: "wip", height: 220, expanded: false });
  });

  it("SET_COMPOSER_EXPANDED is a no-op when the value already matches", () => {
    const seeded = {
      ...initialState,
      composers: { s1: { draft: "x", height: 120, expanded: false } },
    };
    const next = sessionReducer(seeded, {
      type: "SET_COMPOSER_EXPANDED",
      sessionId: "s1",
      expanded: false,
    });
    expect(next).toBe(seeded);
  });

  it("SET_COMPOSER_EXPANDED updates only the target session", () => {
    const seeded = {
      ...initialState,
      composers: {
        s1: { draft: "x", height: 120, expanded: false },
        s2: { draft: "y", height: 200, expanded: true },
      },
    };
    const next = sessionReducer(seeded, {
      type: "SET_COMPOSER_EXPANDED",
      sessionId: "s1",
      expanded: true,
    });
    expect(next.composers["s1"]).toEqual({ draft: "x", height: 120, expanded: true });
    expect(next.composers["s2"]).toBe(seeded.composers["s2"]);
  });

  it("SESSION_REMOVED cleans up the removed session's composer entry but keeps others", () => {
    const seeded = {
      ...initialState,
      sessions: {
        s1: { id: "s1" } as never,
        s2: { id: "s2" } as never,
      },
      composers: {
        s1: { draft: "to-remove", height: 200, expanded: true },
        s2: { draft: "keep", height: 300, expanded: false },
      },
      activeSessionId: "s2",
      layout: { root: null, focusedPaneId: null },
    };
    const next = sessionReducer(seeded, { type: "SESSION_REMOVED", id: "s1" });
    expect(next.composers["s1"]).toBeUndefined();
    expect(next.composers["s2"]).toEqual({ draft: "keep", height: 300, expanded: false });
  });

  it("SESSION_REMOVED with no composer entry for the removed session is a no-op for composers", () => {
    const seeded = {
      ...initialState,
      sessions: {
        s1: { id: "s1" } as never,
        s2: { id: "s2" } as never,
      },
      composers: {
        s2: { draft: "keep", height: 300, expanded: false },
      },
      activeSessionId: "s2",
      layout: { root: null, focusedPaneId: null },
    };
    const run = () => sessionReducer(seeded, { type: "SESSION_REMOVED", id: "s1" });
    expect(run).not.toThrow();
    const next = run();
    expect(next.composers["s2"]).toEqual({ draft: "keep", height: 300, expanded: false });
    expect(next.composers["s1"]).toBeUndefined();
    expect(next.sessions["s1"]).toBeUndefined();
    expect(next.sessions["s2"]).toBeDefined();
  });
});

// ─── submitToPty tests ───────────────────────────────────────────────

describe("submitToPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults that vi.clearAllMocks resets implementation for.
    (writeToSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(0);
  });

  it("calls dismissSuggestions and clearGhostText once each, before writeToSession", async () => {
    const dismissOrder: number[] = [];
    const ghostOrder: number[] = [];
    const writeOrder: number[] = [];
    let counter = 0;
    (dismissSuggestions as ReturnType<typeof vi.fn>).mockImplementation(() => {
      dismissOrder.push(++counter);
    });
    (clearGhostText as ReturnType<typeof vi.fn>).mockImplementation(() => {
      ghostOrder.push(++counter);
    });
    (writeToSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      writeOrder.push(++counter);
    });

    await submitToPty("sess-a", "echo hi");

    expect(dismissSuggestions).toHaveBeenCalledTimes(1);
    expect(dismissSuggestions).toHaveBeenCalledWith("sess-a");
    expect(clearGhostText).toHaveBeenCalledTimes(1);
    expect(clearGhostText).toHaveBeenCalledWith("sess-a");
    expect(writeToSession).toHaveBeenCalledTimes(1);

    // Both pre-write hooks must run before the actual PTY write.
    expect(dismissOrder[0]).toBeLessThan(writeOrder[0]);
    expect(ghostOrder[0]).toBeLessThan(writeOrder[0]);
  });

  it("prepends one backspace byte per character reported by getInputBufferLength and clears the buffer", async () => {
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(3);

    await submitToPty("sess-b", "ls");

    expect(getInputBufferLength).toHaveBeenCalledWith("sess-b");
    expect(clearInputBuffer).toHaveBeenCalledTimes(1);
    expect(clearInputBuffer).toHaveBeenCalledWith("sess-b");

    const calls = (writeToSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [calledSessionId, b64] = calls[0];
    expect(calledSessionId).toBe("sess-b");

    const bytes = decodeBase64ToBytes(b64 as string);
    // First three bytes must be 0x7f backspaces.
    expect(bytes[0]).toBe(0x7f);
    expect(bytes[1]).toBe(0x7f);
    expect(bytes[2]).toBe(0x7f);
    // Fourth byte is ESC starting the bracketed-paste prefix.
    expect(bytes[3]).toBe(0x1b);
  });

  it("wraps text with bracketed-paste markers and ends with carriage return", async () => {
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(0);

    await submitToPty("sess-c", "hello");

    const calls = (writeToSession as ReturnType<typeof vi.fn>).mock.calls;
    const bytes = decodeBase64ToBytes(calls[0][1] as string);
    const expected = new TextEncoder().encode("\x1b[200~hello\x1b[201~\r");
    expect(bytesEqual(bytes, expected)).toBe(true);

    // Sanity check on terminator: last byte is CR.
    expect(bytes[bytes.length - 1]).toBe(0x0d);
  });

  it("encodes multibyte UTF-8 characters correctly", async () => {
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const text = "echo héllo 🎉";
    await submitToPty("sess-d", text);

    const calls = (writeToSession as ReturnType<typeof vi.fn>).mock.calls;
    const bytes = decodeBase64ToBytes(calls[0][1] as string);
    const expected = new TextEncoder().encode("\x1b[200~" + text + "\x1b[201~\r");
    expect(bytesEqual(bytes, expected)).toBe(true);
  });

  it("propagates rejections from writeToSession", async () => {
    (writeToSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("pty gone"));

    await expect(submitToPty("sess-e", "anything")).rejects.toThrow("pty gone");
  });

  // ─── Dynamic-effort feature regressions ──────────────────────────

  it("does NOT prepend any effort keyword when sending a plain draft", async () => {
    // The old composer prepended `low/medium/high` in front of every draft;
    // the dynamic-effort feature removed that — `/effort <level>` is now
    // sent as its own message, never inlined into user text.
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const draft = "fix the failing test";
    await submitToPty("sess-effort", draft);

    const calls = (writeToSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const bytes = decodeBase64ToBytes(calls[0][1] as string);
    const decoded = new TextDecoder().decode(bytes);

    // Bracketed-paste body must contain exactly the user's draft, with no
    // leading effort keyword smuggled in.
    expect(decoded).toBe("\x1b[200~" + draft + "\x1b[201~\r");
    expect(decoded).not.toMatch(/^\x1b\[200~(low|medium|high|minimal|max)\s/);
  });

  it("formats `/effort <level>` as a bracketed-paste command payload", async () => {
    // When the user clicks the effort chip the composer sends `/effort high`
    // through the same submitToPty path. The wire format must match how any
    // other slash command is sent so Claude's TUI processes it.
    (getInputBufferLength as ReturnType<typeof vi.fn>).mockReturnValue(0);

    await submitToPty("sess-effort-cmd", "/effort high");

    const calls = (writeToSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [calledSessionId, b64] = calls[0];
    expect(calledSessionId).toBe("sess-effort-cmd");

    const bytes = decodeBase64ToBytes(b64 as string);
    const expected = new TextEncoder().encode("\x1b[200~/effort high\x1b[201~\r");
    expect(bytesEqual(bytes, expected)).toBe(true);
  });
});
