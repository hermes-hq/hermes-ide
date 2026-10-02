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
  isAgentReported,
  isHeuristicSource,
  isOsQuiet,
  lastReportedStatus,
  resumedIndex,
  resumesAfterInput,
  statusOfEvent,
  typedBetween,
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

  it("an idle the agent reported itself never yields to a guess (rule 8; seen with the real Claude: its TUI drawing at startup read as work)", () => {
    // SessionStart (hook) then the helper's "started" echo, then the screen.
    const events = [status(1, "idle", "exact", "hook:claude"), status(2, "idle", "exact", "hi"), status(3, "working", "guessed", "pty"), status(4, "working", "guessed", "os")];
    expect(derive(events)).toMatchObject({ kind: "idle", confidence: "exact", source: "hook:claude" });
    // The agent's own next report still moves it.
    expect(derive([...events, status(5, "working", "exact", "hook:claude")])).toMatchObject({ kind: "working", source: "hook:claude" });
    // A different status from the helper still replaces it (equal certainty).
    expect(derive([...events, status(5, "exited", "exact", "hi")]).kind).toBe("exited");
    // Codex sends its start and its first prompt together; the helper's
    // "started" lands after both and must not read as idle.
    const codex = [status(1, "starting", "exact", "hi"), status(2, "idle", "exact", "hook:codex"), status(2, "working", "exact", "hook:codex"), status(3, "idle", "exact", "hi")];
    expect(derive(codex)).toMatchObject({ kind: "working", source: "hook:codex" });
    // With nothing from the agent, the helper's "started" still counts.
    expect(derive([status(1, "starting", "exact", "hi"), status(2, "idle", "exact", "hi")]).kind).toBe("idle");
    expect(isAgentReported("hook:claude")).toBe(true);
    expect(isAgentReported("stream:opencode")).toBe(true);
    expect(isAgentReported("hi")).toBe(false);
    expect(isAgentReported("osc")).toBe(false);
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

describe("deriveStatus: an answered signal yields when the agent resumes (rule 6)", () => {
  // An OSC-only agent (e.g. Codex): it asks through a terminal notification
  // and never says it went back to work. The person answers in its terminal
  // at `input`; the terminal then guesses working.
  const asked = status(10, "needs_approval", "signal", "osc", "Approval requested: rm -rf node_modules");
  const box = status(12, "needs_answer", "guessed", "pty"); // the box sits silent
  const works = (at: number) => status(at, "working", "guessed", "pty");
  // [name, events, input times, expected kind, expected source]
  const table: [string, SessionEvent[], number[], AgentStatusKind, string][] = [
    ["answered, then working: leaves needs approval", [asked, box, works(30)], [20], "working", "pty"],
    ["answered at the same ms as the signal", [asked, works(30)], [10], "working", "pty"],
    ["working at the same ms as the answer", [asked, works(20)], [20], "working", "pty"],
    ["no input at all: stays", [asked, box, works(30)], [], "needs_approval", "osc"],
    ["typed before the signal only: stays", [asked, box, works(30)], [5], "needs_approval", "osc"],
    ["typed after the working guess only: stays", [asked, works(30)], [40], "needs_approval", "osc"],
    ["answered, but the terminal guesses no work (idle): stays", [asked, status(30, "idle", "guessed", "pty")], [20], "needs_approval", "osc"],
    ["answered, but the terminal guesses a question: stays", [asked, status(30, "needs_answer", "guessed", "pty")], [20], "needs_approval", "osc"],
    ["an exact approval never yields to a guess", [status(10, "needs_approval", "exact", "hook:claude", "Bash"), works(30)], [20], "needs_approval", "hook:claude"],
    ["an exact report from the e2e injector never yields either", [status(10, "needs_approval", "exact", "e2e"), works(30)], [20], "needs_approval", "e2e"],
    ["an attention notification (signal) yields the same way", [{ type: "attention", at: 10, source: "osc", detail: "?" }, works(30)], [20], "working", "pty"],
    ["a signal 'done' yields to the next task's work", [status(10, "done_unread", "signal", "osc"), works(30)], [20], "working", "pty"],
    ["a helper's named guess is not a signal: stays", [status(10, "startup_prompt", "guessed", "hi"), works(30)], [20], "startup_prompt", "hi"],
    ["after resuming, later terminal guesses rule until the agent reports again", [asked, works(30), status(40, "idle", "guessed", "pty")], [20], "idle", "pty"],
    ["the agent's next signal replaces the guess", [asked, works(30), status(50, "needs_approval", "signal", "osc", "again")], [20], "needs_approval", "osc"],
    ["asked again and answered again: yields again", [asked, works(30), status(50, "needs_approval", "signal", "osc"), status(55, "needs_answer", "guessed", "pty"), works(70)], [20, 60], "working", "pty"],
    ["asked again, not answered yet: stays (an old answer does not count)", [asked, works(30), status(50, "needs_approval", "signal", "osc"), works(70)], [20], "needs_approval", "osc"],
  ];

  it.each(table)("%s", (_name, events, inputs, kind, source) => {
    const d = deriveStatus({ snapshot: snapshotOf(events), seenAt: null, inputTimes: inputs });
    expect(d.kind).toBe(kind);
    expect(d.source).toBe(source);
  });

  it("without input times the rule never applies (the old behaviour)", () => {
    expect(derive([asked, box, works(30)]).kind).toBe("needs_approval");
  });

  it("typedBetween is inclusive at both ends", () => {
    expect(typedBetween([10], 10, 20)).toBe(true);
    expect(typedBetween([20], 10, 20)).toBe(true);
    expect(typedBetween([9, 21], 10, 20)).toBe(false);
    expect(typedBetween([], 0, 100)).toBe(false);
  });

  it("resumesAfterInput needs a signal before and the terminal's working guess after", () => {
    const sig = { kind: "needs_approval", confidence: "signal", source: "osc", at: 10 } as const;
    const work = { kind: "working", confidence: "guessed", source: "pty", at: 30 } as const;
    expect(resumesAfterInput(sig, work, [20])).toBe(true);
    expect(resumesAfterInput({ ...sig, confidence: "exact" }, work, [20])).toBe(false);
    expect(resumesAfterInput({ ...sig, source: "pty" }, work, [20])).toBe(false);
    expect(resumesAfterInput({ ...sig, at: null }, work, [20])).toBe(false);
    expect(resumesAfterInput(sig, { ...work, kind: "idle" }, [20])).toBe(false);
    expect(resumesAfterInput(sig, { ...work, source: "hi" }, [20])).toBe(false);
  });

  it("resumedIndex finds the terminal's working guess that superseded a status event", () => {
    const events = [asked, box, works(30), works(40)];
    expect(resumedIndex(events, 0, [20])).toBe(2);
    expect(resumedIndex(events, 0, [35])).toBe(3);
    expect(resumedIndex(events, 0, [])).toBe(-1);
    expect(resumedIndex(events, 0, [50])).toBe(-1);
    expect(resumedIndex([status(10, "needs_approval", "exact", "hook:x"), works(30)], 0, [20])).toBe(-1);
  });
});

describe("deriveStatus: the OS layer (rule 7) sits between named guesses and the screen", () => {
  const osWork = (at: number, detail = "a command is running (zsh)") => status(at, "working", "guessed", "os", detail);
  const osQuiet = (at: number) => status(at, "idle", "guessed", "os");
  const pty = (at: number, kind: AgentStatusKind) => status(at, kind, "guessed", "pty");
  // [name, events, expected kind, expected source]
  const table: [string, SessionEvent[], AgentStatusKind, string | null][] = [
    ["a command running beats the screen's shape", [pty(1, "needs_answer"), osWork(2)], "working", "os"],
    ["the screen's later guess does not replace a process fact", [osWork(1), pty(2, "idle")], "working", "os"],
    ["quiet again: back to the screen's latest guess", [pty(1, "needs_answer"), osWork(2), pty(3, "idle"), osQuiet(4)], "idle", "pty"],
    ["quiet with no screen guess: no opinion but idle", [osWork(1), osQuiet(2)], "idle", "os"],
    ["quiet replaces nothing it did not say", [pty(1, "needs_answer"), osQuiet(2)], "needs_answer", "pty"],
    ["a guess never overrides exact: working from the OS after the agent's done", [status(1, "done_unread", "exact", "hook:x"), osWork(2)], "done_unread", "hook:x"],
    ["nor an exact approval", [status(1, "needs_approval", "exact", "hook:x", "Bash"), osWork(2)], "needs_approval", "hook:x"],
    ["nor does its quiet touch an exact status", [status(1, "working", "exact", "hook:x"), osQuiet(2)], "working", "hook:x"],
    ["a helper's named guess outranks process facts", [status(1, "startup_prompt", "guessed", "hi"), osWork(2, "the agent is using the CPU")], "startup_prompt", "hi"],
    ["a hook's own guess (Antigravity's approval) outranks them too", [status(1, "needs_approval", "guessed", "hook:antigravity", "run_command"), osWork(2)], "needs_approval", "hook:antigravity"],
    ["an exact report replaces a process fact", [osWork(1), status(2, "needs_approval", "exact", "hook:x")], "needs_approval", "hook:x"],
    ["even an exact idle holds: process facts count only below exact reports", [status(1, "idle", "exact", "hook:x"), osWork(2)], "idle", "hook:x"],
    ["a signal's idle yields to process activity, and comes back once quiet", [status(1, "idle", "signal", "osc"), osWork(2), osQuiet(3)], "idle", "osc"],
    ["a guessed idle yields, and the screen's newer guess wins once quiet", [status(1, "idle", "guessed", "hi"), osWork(2), pty(3, "needs_answer"), osQuiet(4)], "needs_answer", "pty"],
    ["an OS exit is a fact like any exit", [status(1, "working", "exact", "hook:x"), { type: "exit", at: 2, source: "os", code: null, signal: null }], "exited", "os"],
  ];
  it.each(table)("%s", (_name, events, kind, source) => {
    const d = derive(events);
    expect(d.kind).toBe(kind);
    expect(d.source).toBe(source);
  });

  it("an answered signal also yields to the OS layer seeing the agent work again", () => {
    const asked = status(10, "needs_approval", "signal", "osc", "Approval requested");
    const d = deriveStatus({ snapshot: snapshotOf([asked, osWork(30)]), seenAt: null, inputTimes: [20] });
    expect(d).toMatchObject({ kind: "working", source: "os" });
    expect(derive([asked, osWork(30)]).kind).toBe("needs_approval");
    expect(resumedIndex([asked, osWork(30)], 0, [20])).toBe(1);
  });

  it("isHeuristicSource / isOsQuiet", () => {
    expect(isHeuristicSource("pty")).toBe(true);
    expect(isHeuristicSource("os")).toBe(true);
    expect(isHeuristicSource("hook:x")).toBe(false);
    expect(isHeuristicSource(null)).toBe(false);
    expect(isOsQuiet(osQuiet(1))).toBe(true);
    expect(isOsQuiet(osWork(1))).toBe(false);
    expect(isOsQuiet(pty(1, "idle"))).toBe(false);
  });

  it("process facts are never what an agent reported", () => {
    expect(lastReportedStatus(snapshotOf([osWork(1)]))).toBeNull();
    expect(lastReportedStatus(snapshotOf([status(1, "done_unread", "exact", "hook:x"), osWork(2)]))?.kind).toBe("done_unread");
  });
});

describe("deriveStatus: an answered ask and an interrupted turn (Claude Code fires no hook for either)", () => {
  const ask = status(1, "needs_approval", "exact", "hook:claude", "Bash");
  // What the OS layer sends once the person's key answered the ask.
  const answered = status(2, "idle", "guessed", "hook:claude");

  it("a key after an exact ask hands the status to the OS layer's verdict", () => {
    expect(derive([ask, answered]).kind).toBe("idle");
    const working = status(3, "working", "guessed", "os", "a command is running (zsh)");
    expect(derive([ask, answered, working])).toMatchObject({ kind: "working", source: "os" });
    // The command ended: the OS layer has no opinion, back to the answer.
    expect(derive([ask, answered, working, status(4, "idle", "guessed", "os")])).toMatchObject({ kind: "idle", source: "hook:claude" });
    // The agent's own report after the command wins again.
    expect(derive([ask, answered, working, status(5, "working", "exact", "hook:claude")]).confidence).toBe("exact");
    // Without the answer the OS layer cannot move an exact ask (rule 7).
    expect(derive([ask, working]).kind).toBe("needs_approval");
  });

  it("an interrupt the agent recorded in its transcript is exact and ends the ask", () => {
    expect(confidenceOfSource("transcript:claude")).toBe("exact");
    expect(isAgentReported("transcript:claude")).toBe(true);
    const interrupted: SessionEvent = { type: "turn_interrupted", at: 3, source: "transcript:claude", n: 2 };
    expect(derive([ask, interrupted])).toMatchObject({ kind: "idle", confidence: "exact", source: "transcript:claude" });
    expect(derive([ask, answered, interrupted])).toMatchObject({ kind: "idle", confidence: "exact" });
    // Hermes's guesses do not move it; the next prompt does.
    expect(derive([ask, interrupted, status(4, "working", "guessed", "os")]).kind).toBe("idle");
    expect(derive([ask, interrupted, status(4, "working", "exact", "hook:claude")]).kind).toBe("working");
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
    expect(certaintyRank("guessed", "hi")).toBeGreaterThan(certaintyRank("guessed", "os"));
    expect(certaintyRank("guessed", "os")).toBeGreaterThan(certaintyRank("guessed", "pty"));
    expect(confidenceOfSource("os")).toBe("guessed");
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

describe("lastReportedStatus: what an agent said, never the terminal's guess", () => {
  it("skips the terminal's guesses, keeps reports and exits", () => {
    expect(lastReportedStatus(snapshotOf([status(1, "working", "guessed", "pty")]))).toBeNull();
    expect(lastReportedStatus(snapshotOf([status(1, "needs_approval", "signal", "osc"), status(2, "working", "guessed", "pty")]))?.kind).toBe("needs_approval");
    expect(lastReportedStatus(snapshotOf([status(1, "working", "exact", "hook:x"), { type: "exit", at: 2, source: "pty", code: 0, signal: null }]))?.kind).toBe("exited");
  });
});
