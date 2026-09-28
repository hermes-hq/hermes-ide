/** C0 contracts: `hi signal` spool records and their mapping to events. */
import { describe, it, expect } from "vitest";
import {
  mapSignalRecord,
  parseSignalRecord,
  signalRecordToSessionEvent,
  signalStatusKind,
  subagentDelta,
  tagsInPayload,
  tagsInText,
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

  it("reads the markers hi lifted into hermes_tags (and any left in a text field) as tags (F21)", () => {
    expect(tagsInText("[hermes-review #3] Please read /fixture/review-3.md")).toEqual(["hermes-review#3"]);
    expect(tagsInText("[hermes-review #3] x [hermes-review #3] y [hermes-gate #12]")).toEqual(["hermes-review#3", "hermes-gate#12"]);
    for (const bad of ["[hermes-review #]", "[hermes-review 3]", "[hermes- #3]", "[hermes-review #x]", "[hermes-review #3", "nothing"]) {
      expect(tagsInText(bad), bad).toEqual([]);
    }
    // What `hi` writes: the list, no prompt text. Malformed entries and doubles are dropped.
    expect(tagsInPayload({ hermes_tags: ["hermes-review#7", "bogus", 3, "hermes-review#7"], cwd: "/x" })).toEqual(["hermes-review#7"]);
    // A text field with a marker still counts, merged without doubles.
    expect(tagsInPayload({ hermes_tags: ["hermes-review#7"], title: "[hermes-review #7] and [hermes-gate #1]" })).toEqual(["hermes-review#7", "hermes-gate#1"]);
    expect(tagsInPayload({ hermes_tags: "hermes-review#7" })).toEqual([]);
    const ev = signalRecordToSessionEvent(record({ event: "UserPromptSubmit", payload: { hermes_tags: ["hermes-review#7"] } }), "n-abc");
    expect(ev).toEqual({
      type: "status",
      at: 1790000000000,
      source: "hook:claude",
      tags: ["hermes-review#7"],
      status: { kind: "working", confidence: "exact", detail: "" },
    });
    // Without markers no tags field appears at all; a turn's end comes the same way.
    expect(signalRecordToSessionEvent(record({ event: "UserPromptSubmit", payload: {} }), "n-abc")).not.toHaveProperty("tags");
    expect(signalRecordToSessionEvent(record({ event: "Stop", payload: {} }), "n-abc")).toMatchObject({ type: "status", status: { kind: "done_unread" } });
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
