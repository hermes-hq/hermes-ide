/**
 * Regression tests for phantom context dirty bug.
 *
 * BUG: Context version incremented (marking dirty) even when no structural
 * change occurred, because:
 *   1. sessionSyncKey useMemo depended on `[session]` object reference —
 *      every SESSION_UPDATED event created a new reference, recomputing
 *      the key and unconditionally calling setContext.
 *   2. Realm listener called setContext with fresh array objects even when
 *      realm data was structurally identical.
 *
 * FIX:
 *   1. Replaced useMemo with a useRef-based guard that compares the
 *      serialized key string before calling setContext.
 *   2. Added structuralEqual guard in the realm listener's setContext
 *      callback to return `prev` when realms haven't changed.
 */
import { describe, it, expect } from "vitest";
import { structuralEqual, structuralClone } from "../utils/structuralEqual";

// ─── Helpers ─────────────────────────────────────────────────────────

interface MockSessionData {
  id: string;
  working_directory: string;
  workspace_paths: string[];
  detected_agent: { name: string; model: string } | null;
  metrics: {
    memory_facts: Array<{ key: string; value: string }>;
    files_touched: string[];
    recent_errors: string[];
  };
}

function makeSession(overrides?: Partial<MockSessionData>): MockSessionData {
  return {
    id: "sess-1",
    working_directory: "/home/user/project",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      memory_facts: [],
      files_touched: [],
      recent_errors: [],
    },
    ...overrides,
  };
}

/** Simulate the sessionSyncKey serialization logic from useContextState */
function computeSyncKey(session: MockSessionData): string {
  return JSON.stringify({
    wd: session.working_directory,
    wp: session.workspace_paths,
    agent: session.detected_agent?.name ?? null,
    model: session.detected_agent?.model ?? null,
    mf: session.metrics.memory_facts,
    ft: session.metrics.files_touched,
    re: session.metrics.recent_errors,
  });
}

/** Simulate the ref-based guard pattern from the fix */
function simulateSessionSyncWithGuard(sessions: MockSessionData[]): number {
  let prevKey = "";
  let setContextCallCount = 0;

  for (const session of sessions) {
    const key = computeSyncKey(session);
    if (key === prevKey) continue; // guard: skip if no real change
    prevKey = key;
    setContextCallCount++;
  }

  return setContextCallCount;
}

interface MockRealmContext {
  realms: Array<{
    realm_id: string;
    realm_name: string;
    languages: string[];
    frameworks: string[];
    conventions: string[];
  }>;
}

// ─── Tests: Session sync key stability ───────────────────────────────

describe("Context dirty regression: sessionSyncKey guard", () => {
  it("identical session updates do NOT trigger setContext", () => {
    const session = makeSession();
    // Simulate 10 SESSION_UPDATED events with identical data but new object refs
    const sessions = Array.from({ length: 10 }, () => makeSession());

    const callCount = simulateSessionSyncWithGuard(sessions);
    // Only the first one should trigger setContext
    expect(callCount).toBe(1);
  });

  it("session with changed working_directory DOES trigger setContext", () => {
    const sessions = [
      makeSession({ working_directory: "/home/user/project-a" }),
      makeSession({ working_directory: "/home/user/project-b" }),
    ];

    const callCount = simulateSessionSyncWithGuard(sessions);
    expect(callCount).toBe(2);
  });

  it("session with changed agent DOES trigger setContext", () => {
    const sessions = [
      makeSession({ detected_agent: null }),
      makeSession({ detected_agent: { name: "anthropic", model: "claude-sonnet" } }),
    ];

    const callCount = simulateSessionSyncWithGuard(sessions);
    expect(callCount).toBe(2);
  });

  it("session with changed files_touched DOES trigger setContext", () => {
    const sessions = [
      makeSession({ metrics: { memory_facts: [], files_touched: ["a.ts"], recent_errors: [] } }),
      makeSession({ metrics: { memory_facts: [], files_touched: ["a.ts", "b.ts"], recent_errors: [] } }),
    ];

    const callCount = simulateSessionSyncWithGuard(sessions);
    expect(callCount).toBe(2);
  });

  it("rapid identical updates with one real change in the middle", () => {
    const base = makeSession();
    const changed = makeSession({ working_directory: "/other" });

    const sessions = [
      base,
      makeSession(), // identical to base (new ref)
      makeSession(), // identical to base (new ref)
      changed,       // actual change
      makeSession({ working_directory: "/other" }), // identical to changed (new ref)
      makeSession({ working_directory: "/other" }), // identical to changed (new ref)
    ];

    const callCount = simulateSessionSyncWithGuard(sessions);
    expect(callCount).toBe(2); // first + the actual change
  });

  it("metrics-only update with same structural data does NOT trigger", () => {
    const sessions = [
      makeSession({ metrics: { memory_facts: [{ key: "k", value: "v" }], files_touched: [], recent_errors: [] } }),
      // New object refs, same values
      makeSession({ metrics: { memory_facts: [{ key: "k", value: "v" }], files_touched: [], recent_errors: [] } }),
    ];

    const callCount = simulateSessionSyncWithGuard(sessions);
    expect(callCount).toBe(1);
  });
});

// ─── Tests: Realm listener structuralEqual guard ─────────────────────

describe("Context dirty regression: realm listener guard", () => {
  it("structuralEqual returns true for identical realm data with new references", () => {
    const realms1 = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: ["React"], conventions: ["camelCase"] },
    ];
    const realms2 = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: ["React"], conventions: ["camelCase"] },
    ];

    // Different references
    expect(realms1).not.toBe(realms2);
    // But structurally equal
    expect(structuralEqual(realms1, realms2)).toBe(true);
  });

  it("structuralEqual returns false when realm data actually changes", () => {
    const realms1 = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: ["React"], conventions: [] },
    ];
    const realms2 = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript", "JavaScript"], frameworks: ["React"], conventions: [] },
    ];

    expect(structuralEqual(realms1, realms2)).toBe(false);
  });

  it("setContext guard returns prev when realms unchanged (no version bump)", () => {
    const prevContext = {
      realms: [
        { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: [], conventions: [] },
      ],
    };

    const newRealms = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: [], conventions: [] },
    ];

    // Simulate the guarded setContext callback
    const updater = (prev: typeof prevContext) => {
      if (structuralEqual(prev.realms, newRealms)) return prev; // no-op
      return { ...prev, realms: newRealms };
    };

    const result = updater(prevContext);
    // Should return the SAME reference (prev), not a new object
    expect(result).toBe(prevContext);
  });

  it("setContext guard returns new object when realms actually changed", () => {
    const prevContext = {
      realms: [
        { realm_id: "r1", realm_name: "proj", languages: ["TypeScript"], frameworks: [], conventions: [] },
      ],
    };

    const newRealms = [
      { realm_id: "r1", realm_name: "proj", languages: ["TypeScript", "Rust"], frameworks: [], conventions: [] },
    ];

    const updater = (prev: typeof prevContext) => {
      if (structuralEqual(prev.realms, newRealms)) return prev;
      return { ...prev, realms: newRealms };
    };

    const result = updater(prevContext);
    expect(result).not.toBe(prevContext);
    expect(result.realms).toEqual(newRealms);
  });

  it("empty realms → empty realms stays clean", () => {
    const prevRealms: unknown[] = [];
    const newRealms: unknown[] = [];
    expect(structuralEqual(prevRealms, newRealms)).toBe(true);
  });
});

// ─── Tests: structuralEqual with array ordering (known limitation) ───

describe("Context dirty regression: array order sensitivity", () => {
  it("structuralEqual is order-sensitive for arrays (by design)", () => {
    const a = ["TypeScript", "JavaScript"];
    const b = ["JavaScript", "TypeScript"];
    // This is intentionally order-sensitive — arrays compared positionally
    expect(structuralEqual(a, b)).toBe(false);
  });

  it("identical array order passes structuralEqual", () => {
    const a = ["TypeScript", "JavaScript"];
    const b = ["TypeScript", "JavaScript"];
    expect(structuralEqual(a, b)).toBe(true);
  });
});

// ─── Tests: Version increment logic ──────────────────────────────────

describe("Context dirty regression: version increment rules", () => {
  it("structuralEqual(prev, next) === true means NO version increment", () => {
    const ctx1 = {
      pinnedItems: [],
      memoryFacts: [],
      realms: [{ realm_id: "r1", languages: ["TS"] }],
      workingDirectory: "/home",
    };
    const ctx2 = structuralClone(ctx1);

    expect(structuralEqual(ctx1, ctx2)).toBe(true);
  });

  it("structuralEqual(prev, next) === false means version DOES increment", () => {
    const ctx1 = {
      pinnedItems: [],
      memoryFacts: [],
      realms: [{ realm_id: "r1", languages: ["TS"] }],
      workingDirectory: "/home",
    };
    const ctx2 = structuralClone(ctx1);
    ctx2.workingDirectory = "/other";

    expect(structuralEqual(ctx1, ctx2)).toBe(false);
  });

  it("adding a pinned item is a structural change", () => {
    const ctx1 = { pinnedItems: [] as unknown[] };
    const ctx2 = { pinnedItems: [{ id: 1, kind: "file", target: "/src/main.ts" }] };
    expect(structuralEqual(ctx1, ctx2)).toBe(false);
  });

  it("adding a memory fact is a structural change", () => {
    const ctx1 = { memoryFacts: [] as unknown[] };
    const ctx2 = { memoryFacts: [{ key: "db", value: "localhost" }] };
    expect(structuralEqual(ctx1, ctx2)).toBe(false);
  });

  it("changing agent is a structural change", () => {
    const ctx1 = { agent: null };
    const ctx2 = { agent: "anthropic" };
    expect(structuralEqual(ctx1, ctx2)).toBe(false);
  });
});

// ─── Tests: Multi-session isolation ──────────────────────────────────

describe("Context dirty regression: multi-session isolation", () => {
  it("sync keys for different sessions are independent", () => {
    const session1 = makeSession({ id: "s1", working_directory: "/project-a" });
    const session2 = makeSession({ id: "s2", working_directory: "/project-b" });

    const key1 = computeSyncKey(session1);
    const key2 = computeSyncKey(session2);

    expect(key1).not.toBe(key2);
  });

  it("changing one session's data doesn't affect another's sync key", () => {
    const session1a = makeSession({ id: "s1", working_directory: "/project-a" });
    const session2 = makeSession({ id: "s2", working_directory: "/project-b" });

    const key1a = computeSyncKey(session1a);
    const key2a = computeSyncKey(session2);

    // Session 1 changes
    const session1b = makeSession({ id: "s1", working_directory: "/project-a-changed" });
    const key1b = computeSyncKey(session1b);
    const key2b = computeSyncKey(session2);

    expect(key1a).not.toBe(key1b); // session 1 changed
    expect(key2a).toBe(key2b);     // session 2 unchanged
  });
});
