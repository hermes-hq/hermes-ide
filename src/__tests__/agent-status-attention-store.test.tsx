// @vitest-environment jsdom
/**
 * F10 — the attention store: the derived status of every session, read with
 * useSyncExternalStore; "done" until a person sees the session; a summary
 * of who needs a person across sessions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SessionEvent } from "../agent/contract/events";
import { _resetSessionEventStoreForTest, clearSessionEvents, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import type { AgentStatusKind } from "../agent/contract/status";
import {
  _resetAttentionStoreForTest,
  forgetSessionStatus,
  getAttentionSummary,
  getSessionStatus,
  markSessionSeen,
  seenAtOf,
  setViewedSession,
  useAttentionSummary,
  useSessionStatus,
} from "../agent/status/attentionStore";

const status = (kind: AgentStatusKind, at: number, source = "hook:x"): SessionEvent => ({
  type: "status",
  at,
  source,
  status: { kind, confidence: source === "pty" ? "guessed" : "exact", detail: "" },
});

afterEach(() => {
  _resetSessionEventStoreForTest();
  _resetAttentionStoreForTest();
});

describe("useSessionStatus", () => {
  it("re-renders when the session's status changes, and only then", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useSessionStatus("a");
    });
    const first = renders;
    expect(result.current.kind).toBe("idle");

    act(() => void dispatchSessionEvent("a", status("needs_approval", 10)));
    expect(result.current.kind).toBe("needs_approval");
    const afterApproval = renders;
    expect(afterApproval).toBe(first + 1);

    // A less sure guess arrives: the status does not change, so no render.
    act(() => void dispatchSessionEvent("a", status("idle", 11, "pty")));
    expect(result.current.kind).toBe("needs_approval");
    expect(renders).toBe(afterApproval);

    // Another session's events never wake this one.
    act(() => void dispatchSessionEvent("b", status("working", 12)));
    expect(renders).toBe(afterApproval);
  });

  it("the snapshot object is stable between changes (useSyncExternalStore requirement)", () => {
    dispatchSessionEvent("a", status("working", 1));
    expect(getSessionStatus("a")).toBe(getSessionStatus("a"));
  });
});

describe("done until seen", () => {
  it("a finished turn in a session nobody looks at stays done; choosing it makes it idle", () => {
    const { result } = renderHook(() => useSessionStatus("bg"));
    act(() => void dispatchSessionEvent("bg", status("done_unread", 100)));
    expect(result.current.kind).toBe("done_unread");
    act(() => markSessionSeen("bg", 200));
    expect(result.current.kind).toBe("idle");
    // The next finished turn is unseen again.
    act(() => void dispatchSessionEvent("bg", status("done_unread", 300)));
    expect(result.current.kind).toBe("done_unread");
  });

  it("a session on screen in a focused window never reads done", () => {
    setViewedSession("fg", 50);
    const { result } = renderHook(() => useSessionStatus("fg"));
    act(() => void dispatchSessionEvent("fg", status("done_unread", 100)));
    expect(result.current.kind).toBe("idle");
    expect(seenAtOf("fg")).toBe(Infinity);
  });

  it("leaving a session counts as having seen it; a later turn end is unseen", () => {
    setViewedSession("x", 10);
    setViewedSession(null, 500);
    expect(seenAtOf("x")).toBe(500);
    dispatchSessionEvent("x", status("done_unread", 400));
    expect(getSessionStatus("x").kind).toBe("idle");
    dispatchSessionEvent("x", status("done_unread", 600));
    expect(getSessionStatus("x").kind).toBe("done_unread");
  });

  it("forgetting a session drops its seen time", () => {
    markSessionSeen("gone", 10);
    forgetSessionStatus("gone");
    expect(seenAtOf("gone")).toBeNull();
  });
});

describe("attention summary", () => {
  it("counts every kind and lists who needs a person, most urgent first", () => {
    dispatchSessionEvent("w", status("working", 1));
    dispatchSessionEvent("e", status("error", 2));
    dispatchSessionEvent("a1", status("needs_approval", 3));
    dispatchSessionEvent("a0", status("needs_approval", 1));
    const s = getAttentionSummary();
    expect(s.counts.working).toBe(1);
    expect(s.counts.needs_approval).toBe(2);
    expect(s.needsYou.map((n) => n.sessionId)).toEqual(["a0", "a1", "e"]);
  });

  it("the hook re-renders when any session changes and drops closed sessions", () => {
    const { result } = renderHook(() => useAttentionSummary());
    expect(result.current.needsYou).toHaveLength(0);
    act(() => void dispatchSessionEvent("q", status("needs_answer", 1)));
    expect(result.current.needsYou.map((n) => n.status.kind)).toEqual(["needs_answer"]);
    const before = result.current;
    expect(getAttentionSummary()).toBe(before);
    act(() => clearSessionEvents("q"));
    expect(result.current.needsYou).toHaveLength(0);
  });
});
