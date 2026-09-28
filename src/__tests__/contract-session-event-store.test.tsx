// @vitest-environment jsdom
/**
 * C0 contracts: the per-session event store, its React hook and the
 * Rust -> frontend channel.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  _resetSessionEventStoreForTest,
  clearSessionEvents,
  dispatchSessionEvent,
  getSessionEventSnapshot,
  reduceSessionEvent,
  SESSION_EVENT_CAP,
  sessionIdsWithEvents,
  subscribeSessionEvents,
  useSessionEvents,
} from "../agent/contract/sessionEventStore";
import {
  _resetSessionEventChannelForTest,
  receiveSessionEventEnvelope,
  SESSION_EVENT_CHANNEL,
  startSessionEventChannel,
} from "../agent/contract/channel";
import type { SessionEvent } from "../agent/contract/events";
import { UNKNOWN_STATUS, type AgentStatusKind } from "../agent/contract/status";

const status = (kind: AgentStatusKind, at = 1): SessionEvent => ({
  type: "status",
  at,
  status: { kind, confidence: "exact", detail: "" },
});

beforeEach(() => {
  _resetSessionEventStoreForTest();
  _resetSessionEventChannelForTest();
});

describe("reduceSessionEvent", () => {
  const empty = getSessionEventSnapshot("s");

  it.each<[string, SessionEvent, (s: ReturnType<typeof reduceSessionEvent>) => void]>([
    ["status sets the status", status("needs_approval"), (s) => expect(s.status.kind).toBe("needs_approval")],
    ["turn_start opens a turn", { type: "turn_start", at: 1, n: 1 }, (s) => expect(s.turn).toEqual({ current: 1, completed: 0 })],
    ["attention keeps the detail", { type: "attention", at: 1, detail: "look" }, (s) => expect(s.attention).toBe("look")],
    [
      "identity fills the identity",
      { type: "identity", at: 1, vendorSessionId: "v1", model: "m", permissionMode: "plan" },
      (s) => expect(s.identity).toEqual({ vendorSessionId: "v1", model: "m", permissionMode: "plan" }),
    ],
    [
      "exit records the exit and sets status exited, exactly",
      { type: "exit", at: 1, code: 2, signal: null },
      (s) => {
        expect(s.exit).toEqual({ code: 2, signal: null });
        expect(s.status).toEqual({ kind: "exited", confidence: "exact", detail: "exit code 2" });
      },
    ],
  ])("%s", (_name, event, check) => {
    const next = reduceSessionEvent(empty, event);
    check(next);
    expect(next.version).toBe(1);
    expect(next.events).toEqual([event]);
    expect(Object.isFrozen(next)).toBe(true);
    expect(empty.version).toBe(0);
  });

  it("closes a turn on end, failure or interruption and counts it", () => {
    for (const type of ["turn_end", "turn_failed", "turn_interrupted"] as const) {
      const started = reduceSessionEvent(empty, { type: "turn_start", at: 1, n: 2 });
      const ended = reduceSessionEvent(started, type === "turn_failed" ? { type, at: 2, n: 2, detail: "boom" } : { type, at: 2, n: 2 });
      expect(ended.turn, type).toEqual({ current: null, completed: 1 });
    }
    // Exit while a turn runs counts that turn as over.
    const started = reduceSessionEvent(empty, { type: "turn_start", at: 1, n: 1 });
    expect(reduceSessionEvent(started, { type: "exit", at: 2, code: null, signal: "SIGKILL" }).turn).toEqual({ current: null, completed: 1 });
    expect(reduceSessionEvent(started, { type: "exit", at: 2, code: null, signal: "SIGKILL" }).status.detail).toBe("signal SIGKILL");
  });

  it("keeps at most SESSION_EVENT_CAP events, dropping the oldest", () => {
    let snap = empty;
    for (let i = 1; i <= SESSION_EVENT_CAP + 5; i++) snap = reduceSessionEvent(snap, { type: "turn_start", at: i, n: i });
    expect(snap.events).toHaveLength(SESSION_EVENT_CAP);
    expect(snap.events[0]).toEqual({ type: "turn_start", at: 6, n: 6 });
    expect(snap.version).toBe(SESSION_EVENT_CAP + 5);
  });
});

describe("the store", () => {
  it("returns a stable empty snapshot until an event lands", () => {
    const a = getSessionEventSnapshot("s1");
    expect(a).toBe(getSessionEventSnapshot("s1"));
    expect(a.status).toBe(UNKNOWN_STATUS);
    expect(sessionIdsWithEvents()).toEqual([]);
    dispatchSessionEvent("s1", status("working"));
    const b = getSessionEventSnapshot("s1");
    expect(b).not.toBe(a);
    expect(b).toBe(getSessionEventSnapshot("s1"));
    expect(sessionIdsWithEvents()).toEqual(["s1"]);
  });

  it("wakes only the subscribers of the session that changed", () => {
    const s1 = vi.fn();
    const s2 = vi.fn();
    const off = subscribeSessionEvents("s1", s1);
    subscribeSessionEvents("s2", s2);
    dispatchSessionEvent("s1", status("working"));
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).not.toHaveBeenCalled();
    off();
    dispatchSessionEvent("s1", status("idle"));
    expect(s1).toHaveBeenCalledTimes(1);
  });

  it("forgets a cleared session and tells its subscribers", () => {
    const l = vi.fn();
    subscribeSessionEvents("s1", l);
    dispatchSessionEvent("s1", status("working"));
    clearSessionEvents("s1");
    expect(l).toHaveBeenCalledTimes(2);
    expect(getSessionEventSnapshot("s1").version).toBe(0);
    expect(sessionIdsWithEvents()).toEqual([]);
  });
});

describe("useSessionEvents", () => {
  it("re-renders with the new snapshot of its session only", () => {
    const { result, rerender } = renderHook(({ id }) => useSessionEvents(id), { initialProps: { id: "s1" } });
    expect(result.current.version).toBe(0);
    act(() => {
      dispatchSessionEvent("s2", status("working"));
    });
    expect(result.current.version).toBe(0);
    act(() => {
      dispatchSessionEvent("s1", status("needs_answer"));
    });
    expect(result.current.status.kind).toBe("needs_answer");
    rerender({ id: "s2" });
    expect(result.current.status.kind).toBe("working");
  });
});

describe("the Rust -> frontend channel", () => {
  it("folds a well-formed envelope into the store and refuses the rest", () => {
    expect(receiveSessionEventEnvelope({ sessionId: "s1", event: status("working") })).toBe(true);
    expect(getSessionEventSnapshot("s1").status.kind).toBe("working");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(receiveSessionEventEnvelope({ sessionId: "s1", event: { type: "nope", at: 1 } })).toBe(false);
    expect(receiveSessionEventEnvelope({ sessionId: "", event: status("idle") })).toBe(false);
    expect(receiveSessionEventEnvelope("junk")).toBe(false);
    expect(receiveSessionEventEnvelope(null)).toBe(false);
    warn.mockRestore();
    expect(getSessionEventSnapshot("s1").version).toBe(1);
  });

  it("listens once on the one channel and feeds the store", async () => {
    const handlers: Array<(msg: { payload: unknown }) => void> = [];
    const listen = vi.fn(async (name: string, handler: (msg: { payload: unknown }) => void) => {
      expect(name).toBe(SESSION_EVENT_CHANNEL);
      handlers.push(handler);
      return () => {};
    });
    await startSessionEventChannel(listen as never);
    await startSessionEventChannel(listen as never);
    expect(listen).toHaveBeenCalledTimes(1);
    handlers[0]({ payload: { sessionId: "s9", event: { type: "identity", at: 1, vendorSessionId: null, model: "m9", permissionMode: null } } });
    expect(getSessionEventSnapshot("s9").identity.model).toBe("m9");
  });
});
