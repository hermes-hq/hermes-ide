/**
 * F27 Done-When: when checks run, where results go, and what "Send failures
 * back" writes. Drives the real controller with fake SessionEvents (the C0
 * store), a fake backend and a fake Tauri event bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetInboxForTest, listInboxItems } from "../agent/contract/inbox";
import { _resetDoneWhenControllerForTest, runChecksNow, sendFailuresBack, startDoneWhen } from "../doneWhen/controller";
import { _resetDoneWhenStoreForTest, checksForTurn, getDoneWhenSnapshot } from "../doneWhen/store";
import { DONE_WHEN_EVENT, parseCheckRecord, type CheckRecord, type RunOutcome } from "../doneWhen/types";
import { failureFeedback, sendBackPayload } from "../doneWhen/feedback";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Handler = (msg: { payload: unknown }) => void;

function fakeBus() {
  const handlers = new Map<string, Handler[]>();
  const listen = <T,>(event: string, handler: (msg: { payload: T }) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler as Handler);
    handlers.set(event, list);
    return Promise.resolve(() => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    });
  };
  const emit = (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) h({ payload });
  };
  return { listen, emit, handlers };
}

function record(overrides: Partial<CheckRecord> & { state?: string; trigger?: string } = {}): CheckRecord {
  const state = overrides.state ?? "failed";
  const raw = {
    session_id: overrides.session_id ?? "s1",
    turn: overrides.turn ?? null,
    check_failed: overrides.check_failed ?? false,
    failed_turns: overrides.failed_turns ?? 1,
    hook: overrides.hook ?? false,
    run: {
      state,
      trigger: overrides.trigger ?? "turn_end",
      source: { kind: "worktree", path: ".hermes/worktree.toml" },
      error: null,
      commands: [
        { command: "npm run lint", exit_code: 0, timed_out: false, duration_ms: 4, output_tail: "" },
        {
          command: "npm test",
          exit_code: state === "failed" ? 1 : 0,
          timed_out: false,
          duration_ms: 9,
          output_tail: "AssertionError: expected 2 to be 3\n\u001b[31m1 failing\u001b[0m",
        },
      ],
      started_at: 1,
      duration_ms: 13,
      final: true,
    },
  };
  const parsed = parseCheckRecord(raw);
  if (!parsed) throw new Error("fixture record did not parse");
  return parsed;
}

let bus: ReturnType<typeof fakeBus>;
let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  _resetSessionEventStoreForTest();
  _resetInboxForTest(() => 1000);
  _resetDoneWhenStoreForTest();
  _resetDoneWhenControllerForTest();
  bus = fakeBus();
  run = vi.fn(async (): Promise<RunOutcome> => ({ skipped: null, record: null }));
  write = vi.fn(async () => {});
  await startDoneWhen({ listen: bus.listen, run, write, now: () => 42 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Done-When controller", () => {
  it("runs the checks when a turn ends, for that turn, and not for other events", async () => {
    dispatchSessionEvent("s1", { type: "turn_start", at: 1, n: 3 });
    dispatchSessionEvent("s1", { type: "status", at: 2, status: { kind: "working", confidence: "exact", detail: "" } });
    expect(run).not.toHaveBeenCalled();
    dispatchSessionEvent("s1", { type: "turn_end", at: 3, n: 3 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("s1", "turn_end", 3);
  });

  it("keeps a result for the chip and on its turn, and the chip stops showing 'checking'", async () => {
    let resolve!: (o: RunOutcome) => void;
    run.mockImplementationOnce(() => new Promise<RunOutcome>((r) => (resolve = r)));
    vi.useFakeTimers();
    const pending = runChecksNow("s1", "turn_end", 2);
    expect(getDoneWhenSnapshot("s1").running).toBe(false); // not for the first moment
    await vi.advanceTimersByTimeAsync(200);
    expect(getDoneWhenSnapshot("s1").running).toBe(true);
    resolve({ skipped: null, record: record({ turn: 2 }) });
    await pending;
    const snap = getDoneWhenSnapshot("s1");
    expect(snap.running).toBe(false);
    expect(snap.last?.run.state).toBe("failed");
    expect(checksForTurn("s1", 2)?.run.commands[1].command).toBe("npm test");
    expect(checksForTurn("s1", 1)).toBeNull();
  });

  it("a turn end the agent's own Stop hook checks shows nothing", async () => {
    run.mockResolvedValueOnce({ skipped: "hook", record: null });
    dispatchSessionEvent("s1", { type: "turn_end", at: 3, n: 1 });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    await Promise.resolve();
    const snap = getDoneWhenSnapshot("s1");
    expect(snap.last).toBeNull();
    expect(snap.running).toBe(false);
  });

  it("a hook report without a turn is put on the session's current turn", () => {
    dispatchSessionEvent("s1", { type: "turn_start", at: 1, n: 5 });
    bus.emit(DONE_WHEN_EVENT, { ...record({ hook: true, trigger: "stop_hook" }), turn: null });
    expect(getDoneWhenSnapshot("s1").last?.turn).toBe(5);
    expect(checksForTurn("s1", 5)).not.toBeNull();
  });

  it("drops a malformed result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bus.emit(DONE_WHEN_EVENT, { session_id: "s1", run: { state: "bogus" } });
    bus.emit(DONE_WHEN_EVENT, "nope");
    expect(getDoneWhenSnapshot("s1").last).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("check_failed raises one error in the inbox; passing checks resolve it", () => {
    bus.emit(DONE_WHEN_EVENT, record({ failed_turns: 1 }));
    expect(listInboxItems()).toHaveLength(0);
    bus.emit(DONE_WHEN_EVENT, record({ check_failed: true, failed_turns: 3 }));
    bus.emit(DONE_WHEN_EVENT, record({ check_failed: true, failed_turns: 4 }));
    const items = listInboxItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error", sessionId: "s1", source: "checks", detail: "Checks failed: npm test" });
    // Another session's result leaves it alone.
    bus.emit(DONE_WHEN_EVENT, record({ session_id: "s2", state: "passed" }));
    expect(listInboxItems()).toHaveLength(1);
    bus.emit(DONE_WHEN_EVENT, record({ state: "passed" }));
    expect(listInboxItems()).toHaveLength(0);
  });

  it("a closed session is forgotten and its item resolved", () => {
    bus.emit(DONE_WHEN_EVENT, record({ check_failed: true }));
    expect(listInboxItems()).toHaveLength(1);
    bus.emit("session-removed", "s1");
    expect(getDoneWhenSnapshot("s1").last).toBeNull();
    expect(listInboxItems()).toHaveLength(0);
  });

  it("Send failures back pastes the failures into the agent's terminal as one message and presses Enter", async () => {
    bus.emit(DONE_WHEN_EVENT, record());
    expect(await sendFailuresBack("s1")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [sessionId, b64] = write.mock.calls[0] as [string, string];
    expect(sessionId).toBe("s1");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("\x1b[200~Hermes Done-When checks failed (from .hermes/worktree.toml).")).toBe(true);
    expect(text.endsWith("\x1b[201~\r")).toBe(true);
    expect(text).toContain("$ npm test (exit 1)");
    expect(text).toContain("AssertionError: expected 2 to be 3");
    expect(text).not.toContain("npm run lint");
    // The output's own escape codes cannot end the paste early.
    const inner = text.slice("\x1b[200~".length, -"\x1b[201~\r".length);
    expect(inner).not.toContain("\x1b");
    expect(getDoneWhenSnapshot("s1").sentAt).toBe(42);
  });

  it("there is nothing to send back when the checks pass or never ran", async () => {
    expect(await sendFailuresBack("s1")).toBe(false);
    bus.emit(DONE_WHEN_EVENT, record({ state: "passed" }));
    expect(await sendFailuresBack("s1")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("a run that fails to start leaves the chip as it was", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    run.mockRejectedValueOnce(new Error("no session s1"));
    expect(await runChecksNow("s1", "manual")).toBeNull();
    expect(getDoneWhenSnapshot("s1")).toMatchObject({ last: null, running: false });
    warn.mockRestore();
  });
});

describe("failure feedback", () => {
  it("names each failing check with the end of its output, under a cap", () => {
    const r = record();
    const huge = { ...r.run, commands: [{ ...r.run.commands[1], output_tail: "x".repeat(20000) + "END" }] };
    const text = failureFeedback(huge);
    expect(text.length).toBeLessThanOrEqual(6001);
    expect(text).toContain("END");
    expect(sendBackPayload(r.run)).toMatch(/^\x1b\[200~[\s\S]*\x1b\[201~\r$/);
  });
});
