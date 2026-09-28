/** C0 contracts: `hi signal` spool records and their mapping to events. */
import { describe, it, expect } from "vitest";
import {
  mapSignalRecord,
  parseSignalRecord,
  signalRecordToSessionEvent,
  signalStatusKind,
  subagentDelta,
  vendorSessionIdOf,
  SIGNAL_PAYLOAD_CAP_BYTES,
} from "../agent/contract/signal";
import type { Confidence } from "../agent/contract/status";
import fixture from "../agent/contract/fixtures/signal-records.json";

const LINE =
  '{"v":1,"ts":1790000000,"session":"s1","agent":"claude","nonce":"n-abc","event":"PermissionRequest","payload":{"tool_name":"Bash"}}';

function record(overrides: Record<string, unknown> = {}) {
  const parsed = parseSignalRecord(LINE);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.record, ...overrides };
}

describe("parseSignalRecord", () => {
  it("reads the one-line format the helper writes", () => {
    expect(parseSignalRecord(LINE)).toEqual({
      ok: true,
      record: { v: 1, ts: 1790000000, session: "s1", agent: "claude", nonce: "n-abc", event: "PermissionRequest", payload: { tool_name: "Bash" } },
    });
    expect(parseSignalRecord('{"v":1,"ts":1,"session":"s","agent":"a","nonce":"n","event":"Stop"}')).toMatchObject({ ok: true, record: { payload: {} } });
  });

  it.each([
    ["not json", "not JSON"],
    ["[1]", "not an object"],
    ['{"v":2,"ts":1,"session":"s","agent":"a","nonce":"n","event":"Stop"}', "unsupported version 2"],
    ['{"v":1,"ts":1,"session":"","agent":"a","nonce":"n","event":"Stop"}', "missing session"],
    ['{"v":1,"ts":1,"session":"s","agent":"a","nonce":"n"}', "missing event"],
    ['{"v":1,"session":"s","agent":"a","nonce":"n","event":"Stop"}', "missing ts"],
    ['{"v":1,"ts":1,"session":"s","agent":"a","nonce":"n","event":"Stop","payload":[]}', "payload is not an object"],
  ])("refuses %s", (line, error) => {
    expect(parseSignalRecord(line)).toEqual({ ok: false, error });
  });

  it("names the payload cap the helper enforces", () => {
    expect(SIGNAL_PAYLOAD_CAP_BYTES).toBe(8192);
  });
});

describe("signalRecordToSessionEvent", () => {
  it("maps a nonce-verified permission event to an exact needs_approval status", () => {
    expect(signalRecordToSessionEvent(record(), "n-abc")).toEqual({
      type: "status",
      at: 1790000000000,
      source: "hook:claude",
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash" },
    });
  });

  it("never trusts a record whose nonce does not match", () => {
    expect(signalRecordToSessionEvent(record(), "other")).toBeNull();
    expect(signalRecordToSessionEvent(record({ nonce: "" }), "")).not.toBeNull(); // the caller owns the nonce
  });

  it("covers the status map of the signals report", () => {
    expect(signalStatusKind("Stop")).toBe("done_unread");
    expect(signalStatusKind("UserPromptSubmit")).toBe("working");
    expect(signalStatusKind("ExitPlanMode")).toBe("plan_ready");
    expect(signalStatusKind("AskUserQuestion")).toBe("needs_answer");
    expect(signalStatusKind("Failure")).toBe("error");
    expect(signalStatusKind("Notification")).toBeNull();
    expect(signalStatusKind("Whatever")).toBeNull();
    expect(signalRecordToSessionEvent(record({ event: "SessionEnd" }), "n-abc")).toEqual({
      type: "exit",
      at: 1790000000000,
      source: "hook:claude",
      code: null,
      signal: null,
    });
    expect(signalRecordToSessionEvent(record({ event: "Notification", payload: { message: "  waiting for input " } }), "n-abc")).toEqual({
      type: "attention",
      at: 1790000000000,
      source: "hook:claude",
      detail: "waiting for input",
    });
    expect(signalRecordToSessionEvent(record({ event: "Whatever" }), "n-abc")).toBeNull();
  });

  it("caps the detail it lifts from the payload", () => {
    const ev = signalRecordToSessionEvent(record({ payload: { message: "x".repeat(500) } }), "n-abc");
    expect(ev?.type === "status" && ev.status.detail.length).toBe(200);
  });
});

describe("mapSignalRecord (F11: every agent, shared with the Rust side)", () => {
  it("maps every case of the shared fixture to exactly the same events as Rust", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
    for (const c of fixture.cases) {
      const parsed = parseSignalRecord(JSON.stringify(c.record));
      expect(parsed.ok, c.name).toBe(true);
      if (!parsed.ok) continue;
      const got = mapSignalRecord(parsed.record, c.nonce, c.confidence as Confidence, `hook:${parsed.record.agent}`);
      expect(got, c.name).toEqual(c.events);
      expect(subagentDelta(parsed.record), `${c.name} subagent delta`).toBe((c as { subagentDelta?: number }).subagentDelta ?? 0);
    }
  });

  it("names the vendor conversation whatever the agent calls it", () => {
    expect(vendorSessionIdOf({ "thread-id": "t1" })).toBe("t1");
    expect(vendorSessionIdOf({ conversationId: "c1" })).toBe("c1");
    expect(vendorSessionIdOf({ session_id: "  " })).toBeNull();
    expect(vendorSessionIdOf({})).toBeNull();
  });
});
