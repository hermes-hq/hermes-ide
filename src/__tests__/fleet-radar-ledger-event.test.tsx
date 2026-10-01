// @vitest-environment jsdom
/**
 * F37 (LEAD-04) — Collision Radar follows the turn ledger's own event.
 * Claude Code's Stop hook ends a turn as a status, never as a `turn_end`
 * event, so the radar must re-read a session's turns when the ledger says it
 * recorded one (`hermes:turn-ledger`), not only on `turn_end`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (msg: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (msg: { payload: unknown }) => void) => {
    h.listeners.set(event, cb);
    return () => {
      h.listeners.delete(event);
      h.unlisten(event);
    };
  }),
}));
vi.mock("../api/git", () => ({ listAllWorktrees: vi.fn(async () => []) }));
vi.mock("../api/settings", () => ({ getSettings: vi.fn(async () => ({})), setSetting: vi.fn(async () => {}) }));

import { useFleetControls } from "../fleet/useFleetControls";
import { _resetRadarForTest, getSessionOverlap, setTurnSourceForTest } from "../fleet/radarStore";
import { _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { _resetFleetCapsForTest } from "../fleet/fleetSettings";
import { _resetTaskQueueForTest } from "../fleet/taskQueue";
import { TURN_LEDGER_EVENT } from "../agent/turns/turnLedgerApi";
import type { Turn } from "../agent/contract/turns";
import type { SessionData } from "../types/session";

function session(id: string): SessionData {
  return { id, label: id, ai_provider: "claude", phase: "idle", working_directory: "/repo", created_at: new Date().toISOString() } as unknown as SessionData;
}

const turn = (n: number, paths: string[]): Turn => ({ n, startedAt: 1, endedAt: 2, paths } as unknown as Turn);

beforeEach(() => {
  _resetRadarForTest();
  _resetSessionEventStoreForTest();
  _resetFleetCapsForTest();
  _resetTaskQueueForTest();
  h.listeners.clear();
  h.unlisten.mockClear();
});

afterEach(() => {
  _resetRadarForTest();
});

describe("Collision Radar and the real turn ledger", () => {
  it("re-reads a session's turns when the ledger records one, with no turn_end event", async () => {
    const ledger: Record<string, Turn[]> = { a: [], b: [] };
    setTurnSourceForTest({ listTurns: async (id) => ledger[id] ?? [], getTurnDiff: async () => null });
    const sessions = [session("a"), session("b")];
    const hook = renderHook(() => useFleetControls({ enabled: true, sessions, startTask: async () => null, t: (k) => k }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.listeners.has(TURN_LEDGER_EVENT)).toBe(true);
    expect(getSessionOverlap("a")).toBeNull();

    // Both agents end a turn that touched the same file: only the ledger says so.
    ledger.a = [turn(1, ["src/login.ts"])];
    ledger.b = [turn(1, ["src/login.ts"])];
    await act(async () => {
      h.listeners.get(TURN_LEDGER_EVENT)!({ payload: { sessionId: "a", turn: ledger.a[0] } });
      h.listeners.get(TURN_LEDGER_EVENT)!({ payload: { sessionId: "b", turn: ledger.b[0] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getSessionOverlap("a")?.others.map((o) => o.sessionId)).toEqual(["b"]);
    expect(getSessionOverlap("b")?.others.map((o) => o.sessionId)).toEqual(["a"]);

    // A session that is not in the list is ignored.
    await act(async () => {
      h.listeners.get(TURN_LEDGER_EVENT)!({ payload: { sessionId: "zzz" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getSessionOverlap("zzz")).toBeNull();

    hook.unmount();
    expect(h.unlisten).toHaveBeenCalledWith(TURN_LEDGER_EVENT);
  });
});
