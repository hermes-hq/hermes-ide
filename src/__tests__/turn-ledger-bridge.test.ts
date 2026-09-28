/**
 * F20 — turn ledger: session events reach the backend snapshots.
 *
 * Covers, with the Tauri bridge mocked:
 * - the store's all-sessions subscription hears every accepted event
 * - turn_start / turn_end / turn_failed / turn_interrupted are forwarded to
 *   the backend with the session id, the time and whether the source is
 *   exact (anything but the PTY guess); other events are not
 * - with the flag off the backend is told so and nothing is forwarded
 * - the API wrappers call the right commands with camelCase arguments
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
  _resetSessionEventStoreForTest,
  dispatchSessionEvent,
  subscribeAllSessionEvents,
} from "../agent/contract/sessionEventStore";
import { isExactTurnSource, startTurnLedgerBridge, type TurnLedgerBridgeDeps } from "../agent/turns/turnLedgerBridge";
import { previewRestoreTurn, reportTurnEnded, restoreTurn, setTurnLedgerEnabled } from "../agent/turns/turnLedgerApi";

function deps() {
  const d: TurnLedgerBridgeDeps = {
    setEnabled: vi.fn(() => Promise.resolve()),
    turnStarted: vi.fn(() => Promise.resolve()),
    turnEnded: vi.fn(() => Promise.resolve()),
  };
  return d;
}

beforeEach(() => {
  _resetSessionEventStoreForTest();
  h.invoke.mockReset();
});

describe("subscribeAllSessionEvents", () => {
  it("hears every accepted event of every session, and stops on unsubscribe", () => {
    const heard: string[] = [];
    const stop = subscribeAllSessionEvents((sid, ev) => heard.push(`${sid}:${ev?.type ?? "cleared"}`));
    dispatchSessionEvent("a", { type: "turn_start", at: 1, n: 1 });
    dispatchSessionEvent("b", { type: "attention", at: 2, detail: "x" });
    stop();
    dispatchSessionEvent("a", { type: "turn_end", at: 3, n: 1 });
    expect(heard).toEqual(["a:turn_start", "b:attention"]);
  });
});

describe("startTurnLedgerBridge", () => {
  it("forwards turn boundaries to the backend, exact unless the source is the PTY guess", () => {
    const d = deps();
    const stop = startTurnLedgerBridge(true, d);
    expect(d.setEnabled).toHaveBeenCalledWith(true);
    dispatchSessionEvent("s1", { type: "turn_start", at: 100, n: 1, source: "hook:claude" });
    dispatchSessionEvent("s1", { type: "status", at: 101, status: { kind: "working", confidence: "exact", detail: "" } });
    dispatchSessionEvent("s1", { type: "turn_end", at: 200, n: 1, source: "hook:claude" });
    dispatchSessionEvent("s2", { type: "turn_failed", at: 300, n: 4, detail: "boom", source: "e2e" });
    dispatchSessionEvent("s3", { type: "turn_interrupted", at: 400, n: 2, source: "pty" });
    dispatchSessionEvent("s4", { type: "turn_end", at: 500, n: 1 });
    dispatchSessionEvent("s1", { type: "attention", at: 600, detail: "?" });
    expect(d.turnStarted).toHaveBeenCalledTimes(1);
    expect(d.turnStarted).toHaveBeenCalledWith("s1", 100, true);
    expect(vi.mocked(d.turnEnded).mock.calls).toEqual([
      ["s1", 200, true],
      ["s2", 300, true],
      ["s3", 400, false],
      ["s4", 500, true],
    ]);
    stop();
    dispatchSessionEvent("s1", { type: "turn_end", at: 700, n: 2 });
    expect(d.turnEnded).toHaveBeenCalledTimes(4);
  });

  it("with the flag off tells the backend so and forwards nothing", () => {
    const d = deps();
    startTurnLedgerBridge(false, d);
    expect(d.setEnabled).toHaveBeenCalledWith(false);
    dispatchSessionEvent("s1", { type: "turn_end", at: 1, n: 1 });
    expect(d.turnEnded).not.toHaveBeenCalled();
  });

  it("starting again replaces the first subscription, so an event is forwarded once", () => {
    const d = deps();
    startTurnLedgerBridge(true, d);
    startTurnLedgerBridge(true, d);
    dispatchSessionEvent("s1", { type: "turn_end", at: 1, n: 1 });
    expect(d.turnEnded).toHaveBeenCalledTimes(1);
  });

  it("classifies sources", () => {
    expect(isExactTurnSource({ type: "turn_end", at: 1, n: 1, source: "pty" })).toBe(false);
    expect(isExactTurnSource({ type: "turn_end", at: 1, n: 1, source: "hook:codex" })).toBe(true);
    expect(isExactTurnSource({ type: "turn_end", at: 1, n: 1 })).toBe(true);
  });
});

describe("the ledger API", () => {
  it("calls the backend commands with camelCase arguments", async () => {
    h.invoke.mockResolvedValue(undefined);
    await setTurnLedgerEnabled(true);
    expect(h.invoke).toHaveBeenLastCalledWith("set_turn_ledger_enabled", { enabled: true });
    await reportTurnEnded("s1", 5, false);
    expect(h.invoke).toHaveBeenLastCalledWith("turn_ledger_turn_ended", { sessionId: "s1", at: 5, exact: false });
    h.invoke.mockResolvedValueOnce({ turn: { n: 2 }, patch: "", diffstat: { files: 1, insertions: 0, deletions: 1 } });
    const preview = await previewRestoreTurn("s1", 2);
    expect(h.invoke).toHaveBeenLastCalledWith("preview_restore_turn", { sessionId: "s1", n: 2 });
    expect(preview?.diffstat.files).toBe(1);
    h.invoke.mockResolvedValueOnce({ n: 2, files: 3 });
    await expect(restoreTurn("s1", 2)).resolves.toEqual({ n: 2, files: 3 });
    expect(h.invoke).toHaveBeenLastCalledWith("restore_turn", { sessionId: "s1", n: 2 });
  });
});
