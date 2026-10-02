// ─── deriveStatus: SessionEvents -> the one status a session shows ────
//
// F10 (docs/adr/004-2.0-contracts.md §1). Every provider (the terminal, the
// optional Agent view, agent hooks, OSC notifications, plugins) reports into
// the same per-session event store. This folds a session's events into the
// single AgentStatus the sidebar, the status strip and the inbox show.
//
// Pure and vendor-neutral: it reads events and their `source` only.
//
// Precedence, in words:
//   1. A process exit is a fact: it always wins.
//   2. A report at least as certain as the current one replaces it.
//   3. A source may always correct itself (the launch helper replacing its
//      own "starting" with a guessed "waiting at a startup prompt").
//   4. A less certain report cannot replace a more certain one, except
//      over `idle`: a quiet state yields to any evidence of activity.
//   5. An agent reported as ended inside a terminal that is still open
//      (the launch helper's "ended", not the process exiting) stays
//      "exited" while the shell sits idle, and yields to any other
//      evidence that something runs there again.
//   6. A report at signal confidence (a terminal notification any program
//      could print, e.g. an OSC-only agent's "approval requested") yields
//      when the agent visibly resumes: the terminal's working guess, made
//      after the person typed into the session after that report (or the
//      OS layer seeing it work again). An exact report never yields to a
//      guess.
//   7. The OS layer (source "os": the agent's process tree, a command
//      running under it, its CPU use) says "working" or, once quiet, has
//      no opinion: its quiet `idle` only takes back its own "working"
//      (falling back to the terminal's latest guess) and replaces nothing
//      else.
//   8. What the agent reported itself (a hook, its event stream, its
//      protocol) at exact confidence never yields to Hermes's own guesses,
//      not even an idle (rule 4's exception), and an equal report from
//      Hermes's bookkeeping does not take its place as the source.
// Certainty tiers, highest first: exact, signal, guessed, then the OS
// layer's process facts, and below everything the terminal's generic
// heuristics (source "pty"), so a helper's specific guess is never
// overwritten by process facts or shell-output shapes, and a process fact
// never by a screen shape.
//
// Known limit (F11 reconciles it): an exact `working` holds until the agent
// reports again, so an agent that stops without saying so keeps showing
// working until its next hook event.

import type { SessionEvent } from "../contract/events";
import type { SessionEventSnapshot } from "../contract/sessionEventStore";
import { UNKNOWN_STATUS, type AgentStatus, type AgentStatusKind, type Confidence } from "../contract/status";

/** A status plus where and when it came from. */
export interface DerivedStatus extends AgentStatus {
  /** When the deciding event happened (epoch ms); null when nothing reported. */
  readonly at: number | null;
  /** The deciding event's source; null when unknown. */
  readonly source: string | null;
  /**
   * Set on `exited` when the session's process itself ended (an `exit`
   * event), as opposed to an agent reported as ended in a live terminal.
   */
  readonly processExited?: true;
}

export const PTY_SOURCE = "pty";
/** The OS layer: facts about the agent's processes (src-tauri pty/os_activity.rs). */
export const OS_SOURCE = "os";

/**
 * Whether a source is one of Hermes's own observations (the terminal's
 * screen heuristics, the OS layer's process facts) rather than something
 * the agent, a notification or a plugin reported.
 */
export function isHeuristicSource(source: string | null | undefined): boolean {
  return source === PTY_SOURCE || source === OS_SOURCE;
}

/**
 * How sure an event is when it does not say so itself (turn, attention and
 * exit events carry no confidence): by where it came from.
 */
export function confidenceOfSource(source: string | undefined | null): Confidence {
  if (!source) return "signal";
  if (isHeuristicSource(source)) return "guessed";
  // "transcript:<agent>": what the agent wrote in its own transcript (a turn
  // the person interrupted, which no hook reports), read from the file the
  // agent itself named.
  if (source === "hi" || source === "agent-view" || source === "hook" || source.startsWith("hook:") || source.startsWith("protocol:") || source.startsWith("transcript:")) {
    return "exact";
  }
  return "signal";
}

/**
 * Higher is more certain. Among guesses: a named guess (the launch helper's,
 * an agent hook's), then the OS layer's process facts, then the terminal's
 * screen heuristics.
 */
export function certaintyRank(confidence: Confidence, source: string | null | undefined): number {
  switch (confidence) {
    case "exact":
      return 6;
    case "signal":
      return 4;
    case "guessed":
      return source === PTY_SOURCE ? 0 : source === OS_SOURCE ? 1 : 2;
  }
}

/** Kinds a less certain report may replace. */
const YIELDING: ReadonlySet<AgentStatusKind> = new Set<AgentStatusKind>(["idle"]);

/** The status an event means on its own, or null when it says nothing about status. */
export function statusOfEvent(event: SessionEvent): DerivedStatus | null {
  const source = event.source ?? null;
  const confidence = confidenceOfSource(event.source);
  const make = (kind: AgentStatusKind, detail = "", c: Confidence = confidence): DerivedStatus => ({
    kind,
    confidence: c,
    detail,
    at: event.at,
    source,
  });
  switch (event.type) {
    case "status":
      return { ...event.status, at: event.at, source };
    case "turn_start":
      return make("working");
    case "turn_end":
      return make("done_unread");
    case "turn_failed":
      return make("error", event.detail);
    case "turn_interrupted":
      return make("idle");
    case "attention":
      return make("needs_answer", event.detail);
    case "exit":
      // The detail stays empty: the renderer words the exit from the
      // snapshot's { code, signal } in the person's language.
      return { ...make("exited", "", "exact"), processExited: true };
    case "identity":
    case "subagents":
    case "usage":
    // N19: a limit travels with its own `limited` status event.
    case "limit":
    // F14: context reports and compactions say nothing about status.
    case "context":
    case "compacted":
      return null;
    // CAP: the CLI refused the launch; Hermes stopped it (an exact error).
    case "launch_rejected":
      return make("error", event.vendorMessage, "exact");
  }
}

const NO_INPUT: readonly number[] = Object.freeze([]);

/** Whether the person typed into the session between `from` and `to` (epoch ms, inclusive). */
export function typedBetween(inputTimes: readonly number[], from: number, to: number): boolean {
  return inputTimes.some((t) => t >= from && t <= to);
}

type Report = Pick<DerivedStatus, "kind" | "confidence" | "source" | "at">;

/**
 * Rule 6: `next` is the agent visibly resuming after `current`, a signal:
 * the terminal's (or the OS layer's) working guess, made after the person
 * typed into the session after the signal.
 */
export function resumesAfterInput(current: Report, next: Report, inputTimes: readonly number[]): boolean {
  return (
    current.confidence === "signal" &&
    !isHeuristicSource(current.source) &&
    current.at !== null &&
    next.kind === "working" &&
    isHeuristicSource(next.source) &&
    next.at !== null &&
    typedBetween(inputTimes, current.at, next.at)
  );
}

/**
 * For readers that show the last report from anywhere but the terminal's
 * heuristics (the status strip, the inbox): the index of the terminal's
 * working guess that superseded the status event at `index` by rule 6, or
 * -1 when nothing did.
 */
export function resumedIndex(events: readonly SessionEvent[], index: number, inputTimes: readonly number[]): number {
  const e = events[index];
  if (!e || !inputTimes.length) return -1;
  const report = statusOfEvent(e);
  if (!report) return -1;
  for (let j = index + 1; j < events.length; j++) {
    const later = events[j];
    if (later.type !== "status" || !isHeuristicSource(later.source)) continue;
    if (resumesAfterInput(report, { ...later.status, at: later.at, source: later.source ?? null }, inputTimes)) return j;
  }
  return -1;
}

/** Whether `next` replaces `current` (see the precedence rules above). */
export function replaces(current: DerivedStatus, next: DerivedStatus, nextIsExit: boolean, inputTimes: readonly number[] = NO_INPUT): boolean {
  if (nextIsExit) return true;
  if (current.source !== null && current.source === next.source) return true;
  // Rule 7: process facts count only below what an agent reported exactly.
  if (next.source === OS_SOURCE && current.confidence === "exact" && !isHeuristicSource(current.source)) return false;
  // Rule 8: the launch helper's "started" (idle) is bookkeeping, not news
  // about the agent: it lands right after the agent's own start hook — and
  // after its first prompt when both arrive together (Codex) — so it never
  // replaces what the agent reported.
  if (isHelperStartedEcho(next) && isAgentReported(current.source)) return false;
  const cur = certaintyRank(current.confidence, current.source);
  const nxt = certaintyRank(next.confidence, next.source);
  if (nxt >= cur) {
    // The same status again from Hermes's own bookkeeping (the launch
    // helper echoing "started" right after the agent's own start hook)
    // keeps the agent as the source (rule 8).
    if (nxt === cur && next.kind === current.kind && isAgentReported(current.source) && !isAgentReported(next.source)) return false;
    return true;
  }
  if (current.kind === "exited" && !current.processExited) return next.kind !== "idle";
  if (resumesAfterInput(current, next, inputTimes)) return true;
  // Rule 8: an idle the agent itself reported exactly never yields to
  // Hermes's own guesses (its TUI drawing at startup is not work).
  if (current.confidence === "exact" && isAgentReported(current.source) && isHeuristicSource(next.source)) return false;
  return YIELDING.has(current.kind);
}

/** The launch helper saying the agent started (source "hi", idle). */
export function isHelperStartedEcho(report: Pick<DerivedStatus, "kind" | "source">): boolean {
  return report.source === "hi" && report.kind === "idle";
}

/** A source that is the agent itself: its hooks, its event stream, its protocol, its transcript. */
export function isAgentReported(source: string | null | undefined): boolean {
  return !!source && (source.startsWith("hook:") || source.startsWith("stream:") || source.startsWith("protocol:") || source.startsWith("transcript:"));
}

const NOTHING: DerivedStatus = Object.freeze({ ...UNKNOWN_STATUS, at: null, source: null });

/** The OS layer saying it has no opinion any more (rule 7). */
export function isOsQuiet(event: SessionEvent): boolean {
  return event.type === "status" && event.source === OS_SOURCE && event.status.kind === "idle";
}

/** Fold a list of events, oldest first, from `start`. */
export function foldStatus(events: readonly SessionEvent[], start: DerivedStatus = NOTHING, inputTimes: readonly number[] = NO_INPUT): DerivedStatus {
  let current = start;
  // The terminal's latest guess, for when the OS layer takes back its own
  // "working" (rule 7).
  let lastScreenGuess: DerivedStatus | null = null;
  // What the OS layer's "working" replaced, to come back to when it is
  // quiet (unless the screen has guessed since).
  let beforeOs: DerivedStatus | null = null;
  for (const event of events) {
    const next = statusOfEvent(event);
    if (!next) continue;
    if (next.source === PTY_SOURCE) lastScreenGuess = next;
    if (isOsQuiet(event)) {
      if (current.source === OS_SOURCE) {
        const screenIsNewer = lastScreenGuess !== null && (beforeOs === null || (lastScreenGuess.at ?? 0) > (beforeOs.at ?? 0));
        current = (screenIsNewer ? lastScreenGuess : beforeOs) ?? next;
        beforeOs = null;
      }
      continue;
    }
    if (current === NOTHING || replaces(current, next, event.type === "exit", inputTimes)) {
      if (next.source === OS_SOURCE && current.source !== OS_SOURCE) beforeOs = current === NOTHING ? null : current;
      current = next;
    }
  }
  return current;
}

export interface DeriveStatusInput {
  readonly snapshot: SessionEventSnapshot;
  /**
   * When a person last looked at this session (epoch ms), or null when
   * never. `done_unread` older than this reads as `idle`. Pass Infinity
   * while the session is on screen in a focused window.
   */
  readonly seenAt: number | null;
  /**
   * When a person typed into the session (epoch ms, oldest first), for
   * rule 6. Empty or absent: no signal yields to a terminal guess.
   */
  readonly inputTimes?: readonly number[];
}

/**
 * The status a session shows. Pure: the same snapshot and seen time always
 * give the same answer.
 */
export function deriveStatus({ snapshot, seenAt, inputTimes = NO_INPUT }: DeriveStatusInput): DerivedStatus {
  // The store keeps the last SESSION_EVENT_CAP events. When older ones were
  // dropped, start from the last status the store recorded.
  const truncated = snapshot.version > snapshot.events.length;
  const start: DerivedStatus = truncated ? { ...snapshot.status, at: null, source: null } : NOTHING;
  const folded = foldStatus(snapshot.events, start, inputTimes);
  if (folded.kind === "done_unread" && seenAt !== null && (folded.at === null || seenAt >= folded.at)) {
    return { ...folded, kind: "idle" };
  }
  return folded;
}

const EXITED_STATUS: AgentStatus = Object.freeze({ kind: "exited", confidence: "exact", detail: "" });

/**
 * The last status the agent (or a plugin, a hook, a notification) reported,
 * an exit included; Hermes's own observations (the terminal's guesses,
 * source "pty", and the OS layer's, source "os") left out. Null when
 * nothing but those said anything. For features that act on what an agent
 * is doing (the task queue, tiling working agents), where a plain shell's
 * busy prompt must not count.
 */
export function lastReportedStatus(snap: SessionEventSnapshot): AgentStatus | null {
  for (let i = snap.events.length - 1; i >= 0; i--) {
    const e = snap.events[i];
    if (e.type === "exit") return EXITED_STATUS;
    if (e.type === "status" && !isHeuristicSource(e.source)) return e.status;
  }
  return null;
}
