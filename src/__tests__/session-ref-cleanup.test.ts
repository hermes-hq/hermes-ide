/**
 * Regression suite for v1.1.2 H2 + H3 fixes:
 *
 *   H2 — `closeTimers` setTimeout was never cleared when the real
 *        `session-removed` event arrived first, leaking timers and
 *        causing a stale SESSION_REMOVED dispatch 500 ms later.
 *
 *   H3 — `claudeAddDirs`, `lastIdeStateHash`, and `lastAutoAttachCwd`
 *        were never deleted from their per-session Maps when a
 *        session closed, growing unbounded for the lifetime of the
 *        app.
 */

import { describe, it, expect, vi } from "vitest";
import {
  cleanupSessionRefs,
  type SessionRefBundle,
} from "../utils/sessionRefCleanup";

function emptyBundle(): SessionRefBundle {
  return {
    busyTimestamps: new Map(),
    closingSessionIds: new Set(),
    closeTimers: new Map(),
    lastAutoAttachCwd: new Map(),
    claudeUuids: new Map(),
    claudeModels: new Map(),
    claudePermissionModes: new Map(),
    claudeEfforts: new Map(),
    claudeAddDirs: new Map(),
    pendingFlags: new Map(),
    lastIdeStateHash: new Map(),
  };
}

describe("cleanupSessionRefs (v1.1.2 H2 + H3 leak fixes)", () => {
  it("H3: every per-session Map and Set is cleared", () => {
    const b = emptyBundle();
    const sid = "leaky-session";

    b.busyTimestamps.set(sid, Date.now());
    b.closingSessionIds.add(sid);
    b.lastAutoAttachCwd.set(sid, "/tmp");
    b.claudeUuids.set(sid, "uuid-x");
    b.claudeModels.set(sid, "haiku");
    b.claudePermissionModes.set(sid, "default");
    b.claudeEfforts.set(sid, "high");
    b.claudeAddDirs.set(sid, ["/a", "/b"]);
    b.pendingFlags.set(sid, { model: "opus" });
    b.lastIdeStateHash.set(sid, "hash-1");

    const { removed } = cleanupSessionRefs(b, sid);

    expect(removed).toBe(10);
    expect(b.busyTimestamps.has(sid)).toBe(false);
    expect(b.closingSessionIds.has(sid)).toBe(false);
    expect(b.lastAutoAttachCwd.has(sid)).toBe(false);
    expect(b.claudeUuids.has(sid)).toBe(false);
    expect(b.claudeModels.has(sid)).toBe(false);
    expect(b.claudePermissionModes.has(sid)).toBe(false);
    expect(b.claudeEfforts.has(sid)).toBe(false);
    expect(b.claudeAddDirs.has(sid)).toBe(false);
    expect(b.pendingFlags.has(sid)).toBe(false);
    expect(b.lastIdeStateHash.has(sid)).toBe(false);
  });

  it("H3: leaves OTHER sessions' entries untouched", () => {
    const b = emptyBundle();
    b.claudeUuids.set("survivor", "uuid-survivor");
    b.claudeAddDirs.set("survivor", ["/keep"]);
    b.lastIdeStateHash.set("survivor", "hash-survivor");
    b.lastAutoAttachCwd.set("survivor", "/keep");
    b.claudeUuids.set("doomed", "uuid-doomed");

    cleanupSessionRefs(b, "doomed");

    expect(b.claudeUuids.get("survivor")).toBe("uuid-survivor");
    expect(b.claudeAddDirs.get("survivor")).toEqual(["/keep"]);
    expect(b.lastIdeStateHash.get("survivor")).toBe("hash-survivor");
    expect(b.lastAutoAttachCwd.get("survivor")).toBe("/keep");
    expect(b.claudeUuids.has("doomed")).toBe(false);
  });

  it("H2: pending close-fallback timer is cancelled if present", () => {
    vi.useFakeTimers();
    try {
      const b = emptyBundle();
      const fired = vi.fn();
      const t = setTimeout(fired, 500);
      b.closeTimers.set("s1", t);

      const { cancelledTimer } = cleanupSessionRefs(b, "s1");

      expect(cancelledTimer).toBe(true);
      expect(b.closeTimers.has("s1")).toBe(false);
      vi.runAllTimers();
      expect(fired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("H2: cancelledTimer=false when no timer was pending", () => {
    const b = emptyBundle();
    const { cancelledTimer } = cleanupSessionRefs(b, "no-timer-here");
    expect(cancelledTimer).toBe(false);
  });

  it("removed=0 when the session was never tracked", () => {
    const b = emptyBundle();
    const { removed } = cleanupSessionRefs(b, "ghost");
    expect(removed).toBe(0);
  });

  it("KEY REGRESSION: a session with three of the previously-leaked maps gets fully cleaned", () => {
    // This is the EXACT shape that leaked in v1.1.0: claudeAddDirs +
    // lastIdeStateHash + lastAutoAttachCwd were populated by every
    // agent session and never cleared.  After 100 closed sessions
    // that's 100 entries in each Map, growing unbounded.
    const b = emptyBundle();
    const sids = Array.from({ length: 100 }, (_, i) => `s-${i}`);
    for (const sid of sids) {
      b.claudeAddDirs.set(sid, ["/a"]);
      b.lastIdeStateHash.set(sid, `h-${sid}`);
      b.lastAutoAttachCwd.set(sid, `/cwd/${sid}`);
    }
    for (const sid of sids) cleanupSessionRefs(b, sid);
    expect(b.claudeAddDirs.size).toBe(0);
    expect(b.lastIdeStateHash.size).toBe(0);
    expect(b.lastAutoAttachCwd.size).toBe(0);
  });
});
