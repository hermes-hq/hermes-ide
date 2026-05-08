/**
 * Tests for the per-session composer reducer slice.
 *
 * Covers SET_COMPOSER_DRAFT, SET_COMPOSER_HEIGHT, TOGGLE_COMPOSER_EXPANDED,
 * SET_COMPOSER_EXPANDED, and SESSION_REMOVED's cleanup of the new
 * `composers` slice.
 */
import { describe, it, expect } from "vitest";
import { sessionReducer, initialState } from "../state/SessionContext";

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
