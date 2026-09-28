/**
 * F10 — deriveStatus: a session's events -> the one status it shows.
 *
 * Table tests: every AgentStatus kind is reached from events, with the
 * confidence and detail it should carry; then the precedence rules
 * (exit wins, more certain beats less certain, a source corrects itself,
 * idle yields) and the "done until seen" rule.
 */
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../agent/contract/events";
import { reduceSessionEvent, SESSION_EVENT_CAP, type SessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { AGENT_STATUS_KINDS, type AgentStatusKind, type Confidence } from "../agent/contract/status";
import {
  certaintyRank,
  confidenceOfSource,
  deriveStatus,
  foldStatus,
  statusOfEvent,
} from "../agent/status/deriveStatus";

const EMPTY: SessionEventSnapshot = {
  sessionId: "s",
  status: { kind: "idle", confidence: "guessed", detail: "" },
  identity: { vendorSessionId: null, model: null, permissionMode: null },
  turn: { current: null, completed: 0 },
  attention: null,
  exit: null,
  events: [],
  version: 0,
};

function snapshotOf(events: SessionEvent[]): SessionEventSnapshot {
  return events.reduce(reduceSessionEvent, EMPTY);
}

function derive(events: SessionEvent[], seenAt: number | null = null) {
  return deriveStatus({ snapshot: snapshotOf(events), seenAt });
}

const status = (at: number, kind: AgentStatusKind, confidence: Confidence, source?: string, detail = ""): SessionEvent => ({
  type: "status",
  at,
  ...(source ? { source } : {}),
  status: { kind, confidence, detail },
});

describe("deriveStatus: every status kind, table-driven", () => {
  // [kind, events, expected confidence, expected detail]
  const table: [AgentStatusKind, SessionEvent[], Confidence, string][] = [
    ["needs_approval", [status(1, "needs_approval", "exact", "hook:claude", "Bash: rm -rf build")], "exact", "Bash: rm -rf build"],
    ["needs_answer", [{ type: "attention", at: 1, source: "osc", detail: "Which database?" }], "signal", "Which database?"],
    ["gate", [status(1, "gate", "exact", "hermes", "plan")], "exact", "plan"],
    ["check_failed", [status(1, "check_failed", "exact", "hermes", "npm test (3 attempts)")], "exact", "npm test (3 attempts)"],
    ["error", [{ type: "turn_failed", at: 1, source: "hook:codex", n: 1, detail: "tool error" }], "exact", "tool error"],
    ["limited", [status(1, "limited", "signal", "osc", "resets at 14:00")], "signal", "resets at 14:00"],
    ["plan_ready", [status(1, "plan_ready", "exact", "hook:claude")], "exact", ""],
    ["done_unread", [{ type: "turn_start", at: 1, source: "hook:x", n: 1 }, { type: "turn_end", at: 2, source: "hook:x", n: 1 }], "exact", ""],
    ["working", [{ type: "turn_start", at: 1, source: "hook:x", n: 1 }], "exact", ""],
    ["startup_prompt", [status(1, "starting", "exact", "hi"), status(2, "startup_prompt", "guessed", "hi", "folder trust")], "guessed", "folder trust"],
    ["starting", [status(1, "starting", "exact", "hi")], "exact", ""],
    ["idle", [{ type: "turn_start", at: 1, source: "hook:x", n: 1 }, { type: "turn_interrupted", at: 2, source: "hook:x", n: 1 }], "exact", ""],
    ["exited", [status(1, "working", "exact", "hook:x"), { type: "exit", at: 2, source: "pty", code: 0, signal: null }], "exact", ""],
  ];

  it("covers every kind in the vocabulary", () => {
    expect(table.map(([k]) => k).sort()).toEqual([...AGENT_STATUS_KINDS].sort());
  });

  it.each(table)("%s", (kind, events, confidence, detail) => {
    const d = derive(events);
    expect(d.kind).toBe(kind);
    expect(d.confidence).toBe(confidence);
    expect(d.detail).toBe(detail);
    expect(d.at).toBe(events[events.length - 1].at);
  });
});

describe("deriveStatus: nothing reported", () => {
  it("is idle, guessed, with no time or source", () => {
    expect(derive([])).toEqual({ kind: "idle", confidence: "guessed", detail: "", at: null, source: null });
  });
  it("identity events say nothing about status", () => {
    expect(derive([{ type: "identity", at: 5, vendorSessionId: "v", model: "m", permissionMode: null }]).at).toBeNull();
  });
});

describe("deriveStatus: precedence", () => {
  it("an exact approval is not replaced by the terminal's guess (the bug F10 fixes: 'ready' while it waits)", () => {
    const d = derive([status(1, "needs_approval", "exact", "hook:claude", "Bash: npm test"), status(2, "idle", "guessed", "pty")]);
    expect(d.kind).toBe("needs_approval");
    expect(d.detail).toBe("Bash: npm test");
  });

  it("a signal is not replaced by a pty guess, but is by an exact report", () => {
    expect(derive([status(1, "limited", "signal", "osc"), status(2, "working", "guessed", "pty")]).kind).toBe("limited");
    expect(derive([status(1, "limited", "signal", "osc"), status(2, "working", "exact", "hook:x")]).kind).toBe("working");
  });

  it("an equally sure report replaces the current one", () => {
    expect(derive([status(1, "working", "guessed", "pty"), status(2, "needs_answer", "guessed", "pty")]).kind).toBe("needs_answer");
  });

  it("a source may correct itself, even to a less sure report", () => {
    const d = derive([status(1, "starting", "exact", "hi"), status(2, "startup_prompt", "guessed", "hi")]);
    expect(d.kind).toBe("startup_prompt");
    expect(d.confidence).toBe("guessed");
  });

  it("a helper's named guess outranks the terminal's generic heuristics", () => {
    const d = derive([status(1, "startup_prompt", "guessed", "hi"), status(2, "needs_answer", "guessed", "pty")]);
    expect(d.kind).toBe("startup_prompt");
  });

  it("idle yields to any evidence of activity", () => {
    const d = derive([status(1, "idle", "exact", "hi"), status(2, "working", "guessed", "pty")]);
    expect(d.kind).toBe("working");
    expect(d.confidence).toBe("guessed");
  });

  it("an exit always wins, whatever came before", () => {
    const d = derive([status(1, "needs_approval", "exact", "hook:x"), { type: "exit", at: 2, source: "pty", code: 1, signal: null }]);
    expect(d).toMatchObject({ kind: "exited", confidence: "exact" });
  });

  it("after an exit only a sure report or the same source brings the session back", () => {
    const exited: SessionEvent[] = [{ type: "exit", at: 1, source: "agent-view", code: 0, signal: null }];
    expect(derive([...exited, status(2, "idle", "guessed", "pty")]).kind).toBe("exited");
    expect(derive([...exited, status(2, "idle", "exact", "agent-view")]).kind).toBe("idle");
  });

  it("an agent that ended in a live terminal stays exited while the shell idles, and yields to new activity", () => {
    const ended = [status(1, "working", "exact", "hi"), status(2, "exited", "exact", "hi", "declined")];
    expect(derive([...ended, status(3, "idle", "guessed", "pty")])).toMatchObject({ kind: "exited", detail: "declined" });
    expect(derive([...ended, status(3, "idle", "guessed", "pty"), status(4, "working", "guessed", "pty")])).toMatchObject({ kind: "working", source: "pty" });
    expect(derive([...ended, status(3, "working", "guessed", "pty"), status(4, "idle", "guessed", "pty")]).kind).toBe("idle");
  });

  it("the process exiting does not yield to later activity from another source", () => {
    const exited: SessionEvent[] = [{ type: "exit", at: 1, source: "hook:x", code: 0, signal: null }];
    expect(derive([...exited, status(2, "working", "guessed", "pty")]).kind).toBe("exited");
    expect(derive([...exited, { type: "attention", at: 2, source: "osc", detail: "?" }]).kind).toBe("exited");
  });

  it("an exact working holds against later pty guesses (documented limit, F11 reconciles)", () => {
    expect(derive([status(1, "working", "exact", "hook:x"), status(2, "idle", "guessed", "pty")]).kind).toBe("working");
  });
});

describe("deriveStatus: done until seen", () => {
  const done: SessionEvent[] = [{ type: "turn_end", at: 100, source: "hook:x", n: 1 }];
  it("is done while nobody looked", () => {
    expect(derive(done, null).kind).toBe("done_unread");
    expect(derive(done, 99).kind).toBe("done_unread");
  });
  it("reads idle once seen at or after the turn ended, keeping its confidence", () => {
    expect(derive(done, 100)).toMatchObject({ kind: "idle", confidence: "exact", at: 100 });
    expect(derive(done, Infinity).kind).toBe("idle");
  });
});

describe("deriveStatus: a long session", () => {
  it("starts from the store's last status when older events were dropped", () => {
    const events: SessionEvent[] = [status(1, "needs_approval", "exact", "hook:x", "old")];
    for (let i = 0; i < SESSION_EVENT_CAP; i++) events.push({ type: "identity", at: 2 + i, vendorSessionId: null, model: `m${i}`, permissionMode: null });
    const snapshot = snapshotOf(events);
    expect(snapshot.events.some((e) => e.type === "status")).toBe(false);
    expect(deriveStatus({ snapshot, seenAt: null })).toMatchObject({ kind: "needs_approval", detail: "old" });
  });
});

describe("helpers", () => {
  it("confidenceOfSource", () => {
    expect(confidenceOfSource("hook:claude")).toBe("exact");
    expect(confidenceOfSource("agent-view")).toBe("exact");
    expect(confidenceOfSource("hi")).toBe("exact");
    expect(confidenceOfSource("osc")).toBe("signal");
    expect(confidenceOfSource("plugin:acme")).toBe("signal");
    expect(confidenceOfSource(undefined)).toBe("signal");
    expect(confidenceOfSource("pty")).toBe("guessed");
  });
  it("certaintyRank orders exact > signal > named guess > pty guess", () => {
    expect(certaintyRank("exact", "x")).toBeGreaterThan(certaintyRank("signal", "x"));
    expect(certaintyRank("signal", "x")).toBeGreaterThan(certaintyRank("guessed", "hi"));
    expect(certaintyRank("guessed", "hi")).toBeGreaterThan(certaintyRank("guessed", "pty"));
  });
  it("statusOfEvent maps each event type", () => {
    expect(statusOfEvent({ type: "turn_start", at: 1, n: 1 })?.kind).toBe("working");
    expect(statusOfEvent({ type: "identity", at: 1, vendorSessionId: null, model: null, permissionMode: null })).toBeNull();
    expect(statusOfEvent({ type: "subagents", at: 1, running: 2 })).toBeNull();
    expect(statusOfEvent({ type: "exit", at: 1, code: null, signal: "SIGTERM" })).toMatchObject({ kind: "exited", confidence: "exact", detail: "" });
  });
  it("foldStatus is order-sensitive and pure", () => {
    const a = status(1, "working", "guessed", "pty");
    const b = status(2, "idle", "guessed", "pty");
    expect(foldStatus([a, b]).kind).toBe("idle");
    expect(foldStatus([b, a]).kind).toBe("working");
  });
});
