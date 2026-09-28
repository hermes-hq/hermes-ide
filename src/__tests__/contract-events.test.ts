/**
 * C0 contracts: AgentStatus and SessionEvent wire format.
 *
 * The fixture is shared with src-tauri/src/contract/mod.rs, so the same
 * JSON must parse on both sides and come back unchanged.
 */
import { describe, it, expect } from "vitest";
import fixture from "../agent/contract/fixtures/session-events.json";
import { parseSessionEvent, SESSION_EVENT_TYPES } from "../agent/contract/events";
import {
  AGENT_STATUS_KINDS,
  BLOCKING_STATUS_KINDS,
  CONFIDENCES,
  isAgentStatusKind,
  parseAgentStatus,
  UNKNOWN_STATUS,
} from "../agent/contract/status";

describe("AgentStatus", () => {
  it("has the thirteen kinds of the contract, in inbox order", () => {
    expect(AGENT_STATUS_KINDS).toEqual([
      "needs_approval",
      "needs_answer",
      "gate",
      "check_failed",
      "error",
      "limited",
      "plan_ready",
      "done_unread",
      "working",
      "startup_prompt",
      "starting",
      "idle",
      "exited",
    ]);
    expect(CONFIDENCES).toEqual(["exact", "signal", "guessed"]);
    for (const kind of BLOCKING_STATUS_KINDS) expect(isAgentStatusKind(kind)).toBe(true);
    expect(isAgentStatusKind("ready")).toBe(false);
  });

  it("parses every status in the shared fixture and nothing malformed", () => {
    expect(fixture.statuses.map((s) => s.kind)).toEqual([...AGENT_STATUS_KINDS]);
    for (const raw of fixture.statuses) expect(parseAgentStatus(raw)).toEqual(raw);
    expect(parseAgentStatus({ kind: "working", confidence: "exact" })).toEqual({ kind: "working", confidence: "exact", detail: "" });
    expect(parseAgentStatus({ kind: "bogus", confidence: "exact", detail: "" })).toBeNull();
    expect(parseAgentStatus({ kind: "working", confidence: "sure", detail: "" })).toBeNull();
    expect(parseAgentStatus({ kind: "working", confidence: "exact", detail: 3 })).toBeNull();
    expect(parseAgentStatus(null)).toBeNull();
    expect(Object.isFrozen(UNKNOWN_STATUS)).toBe(true);
  });
});

describe("SessionEvent", () => {
  it("parses every event in the shared fixture back to the same JSON", () => {
    const seen = new Set<string>();
    for (const raw of fixture.events) {
      const parsed = parseSessionEvent(raw);
      expect(parsed, JSON.stringify(raw)).not.toBeNull();
      expect(parsed).toEqual(raw);
      seen.add(raw.type);
    }
    expect([...seen].sort()).toEqual([...SESSION_EVENT_TYPES].sort());
  });

  it("refuses every rejected entry of the fixture", () => {
    for (const raw of fixture.rejected) expect(parseSessionEvent(raw), JSON.stringify(raw)).toBeNull();
  });

  it("drops fields it does not know, so a newer producer stays readable", () => {
    expect(parseSessionEvent({ type: "turn_end", at: 1, n: 4, futureField: true })).toEqual({ type: "turn_end", at: 1, n: 4 });
    expect(parseSessionEvent({ type: "exit", at: 1 })).toEqual({ type: "exit", at: 1, code: null, signal: null });
  });

  it("keeps the source when given and refuses a non-string one", () => {
    expect(parseSessionEvent({ type: "attention", at: 1, detail: "x", source: "osc" })).toEqual({ type: "attention", at: 1, detail: "x", source: "osc" });
    expect(parseSessionEvent({ type: "attention", at: 1, detail: "x", source: 5 })).toBeNull();
  });

  it("keeps tags on any event (F21), copies the array, and refuses malformed ones", () => {
    const tags = ["hermes-review#3"];
    const parsed = parseSessionEvent({ type: "turn_start", at: 1, n: 2, tags });
    expect(parsed).toEqual({ type: "turn_start", at: 1, n: 2, tags: ["hermes-review#3"] });
    expect(parsed?.tags).not.toBe(tags);
    expect(parseSessionEvent({ type: "turn_start", at: 1, n: 2, tags: null })).toEqual({ type: "turn_start", at: 1, n: 2 });
    expect(parseSessionEvent({ type: "turn_start", at: 1, n: 2, tags: "hermes-review#3" })).toBeNull();
    expect(parseSessionEvent({ type: "turn_start", at: 1, n: 2, tags: [3] })).toBeNull();
  });
});
