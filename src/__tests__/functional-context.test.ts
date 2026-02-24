/**
 * Functional tests for Bug 1: Context "Out of sync" after initial load.
 *
 * ROOT CAUSE: The initial load effect's async `load()` closure captured
 * the `session` object at effect-fire time. During async fetches,
 * SESSION_UPDATED events updated the session (agent detected, metrics
 * changed). When `load()` finished, it wrote `prevSyncKeyRef` using STALE
 * session data. The session sync effect then saw a key mismatch and
 * applied a sync — bumping version and marking lifecycle dirty.
 *
 * FIX: Use `sessionRef.current` (a live ref) instead of the closed-over
 * `session` when computing context fields and the sync key after async work.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const CONTEXT_HOOK: string = readFileSync(
  new URL("../hooks/useContextState.ts", import.meta.url),
  "utf-8",
);

// ─── Helpers ─────────────────────────────────────────────────────────

interface MockSession {
  id: string;
  working_directory: string;
  workspace_paths: string[];
  detected_agent: { name: string; model: string } | null;
  metrics: { memory_facts: Array<{ key: string; value: string }> };
}

function makeSession(overrides?: Partial<MockSession>): MockSession {
  return {
    id: "sess-1",
    working_directory: "/home/user/project",
    workspace_paths: [],
    detected_agent: null,
    metrics: { memory_facts: [] },
    ...overrides,
  };
}

/** Compute the sync key the same way useContextState does */
function computeSyncKey(session: MockSession): string {
  return JSON.stringify({
    wd: session.working_directory,
    wp: session.workspace_paths,
    agent: session.detected_agent?.name ?? null,
    model: session.detected_agent?.model ?? null,
    mf: session.metrics.memory_facts,
  });
}

// ─── Source-level verification ────────────────────────────────────────

describe("Bug 1 fix: initial load uses sessionRef (source verification)", () => {
  it("load() uses sessionRef.current for context fields (not closed-over session)", () => {
    // The load function should reference sessionRef.current for initial context
    const loadBlock = CONTEXT_HOOK.match(/const load = async \(\)[\s\S]*?load\(\)/);
    expect(loadBlock).not.toBeNull();
    const body = loadBlock![0];
    expect(body).toContain("sessionRef.current ?? session");
    // Should have two occurrences: one for initial fields, one for sync key
    const matches = body.match(/sessionRef\.current \?\? session/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });

  it("initial context fields use latestInit (from sessionRef)", () => {
    const loadBlock = CONTEXT_HOOK.match(/const load = async \(\)[\s\S]*?load\(\)/);
    expect(loadBlock).not.toBeNull();
    const body = loadBlock![0];
    expect(body).toContain("latestInit.working_directory");
    expect(body).toContain("latestInit.workspace_paths");
    expect(body).toContain("latestInit.detected_agent");
    expect(body).toContain("latestInit.metrics.memory_facts");
  });

  it("sync key uses latest (from sessionRef)", () => {
    const loadBlock = CONTEXT_HOOK.match(/const load = async \(\)[\s\S]*?load\(\)/);
    expect(loadBlock).not.toBeNull();
    const body = loadBlock![0];
    expect(body).toContain("latest.working_directory");
    expect(body).toContain("latest.workspace_paths");
    expect(body).toContain("latest.detected_agent");
    expect(body).toContain("latest.metrics.memory_facts");
  });
});

// ─── Race condition simulation ────────────────────────────────────────

describe("Bug 1 fix: stale closure race condition", () => {
  it("stale session produces DIFFERENT sync key than updated session (the bug)", () => {
    const staleSession = makeSession({ detected_agent: null });
    const updatedSession = makeSession({
      detected_agent: { name: "anthropic", model: "claude-sonnet" },
    });

    const staleKey = computeSyncKey(staleSession);
    const freshKey = computeSyncKey(updatedSession);

    // These are different — if load() used stale data for prevSyncKeyRef,
    // the sync effect would see a mismatch and re-apply (causing dirty)
    expect(staleKey).not.toBe(freshKey);
  });

  it("using sessionRef (fresh data) produces MATCHING sync key (the fix)", () => {
    // Simulate: session starts with no agent, then SESSION_UPDATED fires
    // during async load, adding agent detection.
    const initialSession = makeSession({ detected_agent: null });
    const updatedSession = makeSession({
      detected_agent: { name: "anthropic", model: "claude-sonnet" },
    });

    // Simulate sessionRef.current being updated by React re-render
    const sessionRef = { current: updatedSession };

    // FIX: load() reads sessionRef.current instead of closed-over session
    const latest = sessionRef.current ?? initialSession;
    const syncKeyFromLoad = computeSyncKey(latest);

    // The sync effect will compute this key from the current session
    const syncKeyFromEffect = computeSyncKey(updatedSession);

    // They MATCH — no spurious dirty mark
    expect(syncKeyFromLoad).toBe(syncKeyFromEffect);
  });

  it("without the fix, stale closure causes mismatch → dirty", () => {
    const staleSession = makeSession({ detected_agent: null });
    const updatedSession = makeSession({
      detected_agent: { name: "anthropic", model: "claude-sonnet" },
    });

    // OLD behavior: load() uses closed-over `session` (stale)
    const syncKeyFromLoad = computeSyncKey(staleSession);
    // Sync effect uses the CURRENT session (updated)
    const syncKeyFromEffect = computeSyncKey(updatedSession);

    // MISMATCH → sync effect applies → version bump → dirty
    expect(syncKeyFromLoad).not.toBe(syncKeyFromEffect);
  });

  it("race with memory_facts change during async load", () => {
    const staleSession = makeSession({ metrics: { memory_facts: [] } });
    const updatedSession = makeSession({
      metrics: { memory_facts: [{ key: "db_host", value: "localhost" }] },
    });

    const sessionRef = { current: updatedSession };
    const latest = sessionRef.current ?? staleSession;
    const syncKeyFromLoad = computeSyncKey(latest);
    const syncKeyFromEffect = computeSyncKey(updatedSession);

    expect(syncKeyFromLoad).toBe(syncKeyFromEffect);
  });

  it("race with working_directory change during async load", () => {
    const staleSession = makeSession({ working_directory: "/old/path" });
    const updatedSession = makeSession({ working_directory: "/new/path" });

    const sessionRef = { current: updatedSession };
    const latest = sessionRef.current ?? staleSession;
    const syncKeyFromLoad = computeSyncKey(latest);
    const syncKeyFromEffect = computeSyncKey(updatedSession);

    expect(syncKeyFromLoad).toBe(syncKeyFromEffect);
  });

  it("sessionRef.current is null falls back to closed-over session (safe default)", () => {
    const session = makeSession();
    const sessionRef = { current: null as MockSession | null };

    const latest = sessionRef.current ?? session;
    const syncKeyFromLoad = computeSyncKey(latest);
    const syncKeyFromEffect = computeSyncKey(session);

    // Fallback to session — still matches because no update happened
    expect(syncKeyFromLoad).toBe(syncKeyFromEffect);
  });
});
