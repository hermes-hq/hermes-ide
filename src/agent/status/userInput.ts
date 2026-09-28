// ─── When a person typed into a session ───────────────────────────────
//
// F10 x F11. An agent that reports only through terminal notifications
// (OSC 9 / 99 / 777) says "needs approval" but never says it went back to
// work. The derivation (deriveStatus, rule 6) lets the terminal's working
// guess supersede such a signal once the person typed into the session after
// it, so it needs to know when that happened. This keeps those moments per
// session, one mark per gap between two session events (a burst of keys
// with no event in between is one mark), bounded by the event store's cap.
//
// Only keys a person sends count: the terminal's own replies (focus in/out,
// cursor position and device reports) and mouse reports do not.
//
// It also remembers, per session, a key that no output has followed yet, so
// resumeOnOutput.ts can tell the first output after an answer.

import { getSessionEventSnapshot, SESSION_EVENT_CAP } from "../contract/sessionEventStore";

const NO_INPUT: readonly number[] = Object.freeze([]);
const marks = new Map<string, readonly number[]>();
/** The first key since the last output, per session. */
const awaiting = new Map<string, number>();

/**
 * What the terminal sends by itself rather than a person typing: focus
 * reports, cursor position / device attribute / mode reports, OSC replies
 * and mouse reports.
 */
const TERMINAL_REPORT = /^\x1b(?:\[[IO]|\[\??[\d;]*R|\[[?>=][\d;]*c|\[\??[\d;]*\$y|\[<[\d;]+[Mm]|\[M[\s\S]{3}|\][\s\S]*)$/;

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data);
}

/** The session got `data` from the keyboard (or a paste) at `at`. */
export function noteUserInput(sessionId: string, data: string, at: number = Date.now()): void {
  if (!data || isTerminalReport(data)) return;
  if (!awaiting.has(sessionId)) awaiting.set(sessionId, at);
  const prev = marks.get(sessionId) ?? NO_INPUT;
  const events = getSessionEventSnapshot(sessionId).events;
  const lastEventAt = events.length ? events[events.length - 1].at : -Infinity;
  // One mark per gap between events is enough to tell "typed after X".
  if (prev.length && prev[prev.length - 1] >= lastEventAt) return;
  const oldestEventAt = events.length ? events[0].at : -Infinity;
  const kept = prev.filter((t) => t >= oldestEventAt).slice(-(SESSION_EVENT_CAP - 1));
  marks.set(sessionId, Object.freeze([...kept, at]));
}

/** When a person typed into the session, oldest first (the same array until it changes). */
export function userInputTimes(sessionId: string): readonly number[] {
  return marks.get(sessionId) ?? NO_INPUT;
}

/** When the person typed a key no output has followed yet, or null. */
export function inputAwaitingOutput(sessionId: string): number | null {
  return awaiting.get(sessionId) ?? null;
}

/** Output followed the person's keys. */
export function clearInputAwaitingOutput(sessionId: string): void {
  awaiting.delete(sessionId);
}

/** Forget a closed session. */
export function forgetUserInput(sessionId: string): void {
  marks.delete(sessionId);
  awaiting.delete(sessionId);
}

export function _resetUserInputForTest(): void {
  marks.clear();
  awaiting.clear();
}
