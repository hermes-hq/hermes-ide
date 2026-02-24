/**
 * HERMES DIAGNOSTIC EVENT RECORDER
 *
 * Centralized runtime truth recorder. Captures every input event, context
 * lifecycle event, shortcut event, mount event, and PTY write with
 * structured JSON and monotonic sequence numbers.
 *
 * NO filtering. NO dedup. NO guards. Raw truth only.
 */

// ─── Global Debug Flag ──────────────────────────────────────────────

export const HERMES_DEBUG: boolean =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) ||
  (typeof localStorage !== "undefined" && localStorage.getItem("HERMES_DEBUG") === "1");

/**
 * RAW MODE — disables dedup logic, lifecycle guards, and timing workarounds.
 * Activate: localStorage.setItem("HERMES_RAW_MODE", "1") + reload.
 *
 * When active:
 * - TerminalPool: attachCustomKeyEventHandler does NOT suppress printable keydown
 * - useContextState: structuralEqual guards bypassed, initialLoadDone guards bypassed,
 *   prevSyncKeyRef dedup bypassed
 *
 * Purpose: observe the raw unfiltered event sequence for diagnosis.
 */
export const HERMES_RAW_MODE: boolean =
  (typeof localStorage !== "undefined" && localStorage.getItem("HERMES_RAW_MODE") === "1");

// ─── Event Types ────────────────────────────────────────────────────

export type EventCategory =
  | "INPUT"      // keyboard/composition/beforeinput/input events
  | "TERMINAL"   // terminal.onData, attachCustomKeyEventHandler
  | "PTY"        // writeToSession, pty-output
  | "CONTEXT"    // context lifecycle, injection, version
  | "SHORTCUT"   // sendShortcutCommand
  | "MOUNT"      // component mount/unmount, terminal create/destroy
  | "WINDOW";    // window-level events

export interface DiagnosticEvent {
  seq: number;
  ts: number;           // performance.now()
  category: EventCategory;
  event: string;        // e.g. "keydown", "onData", "INJECTION_TRIGGER"
  sessionId: string;
  payload: string;      // JSON.stringify(data)
  charCodes?: number[];
  extra?: Record<string, unknown>;
}

// ─── Event Store ────────────────────────────────────────────────────

let _seq = 0;
const MAX_EVENTS = 5000;
const events: DiagnosticEvent[] = [];
const subscribers = new Set<(event: DiagnosticEvent) => void>();

export function record(
  category: EventCategory,
  event: string,
  sessionId: string,
  data: unknown,
  extra?: Record<string, unknown>,
): DiagnosticEvent | null {
  if (!HERMES_DEBUG) return null;

  const seq = ++_seq;
  const ts = performance.now();

  let payload: string;
  let charCodes: number[] | undefined;

  if (typeof data === "string") {
    payload = JSON.stringify(data);
    charCodes = [...data].map(c => c.charCodeAt(0));
  } else {
    payload = JSON.stringify(data);
  }

  const entry: DiagnosticEvent = {
    seq,
    ts,
    category,
    event,
    sessionId,
    payload,
    charCodes,
    extra,
  };

  // Store
  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();

  // Console output — structured JSON line
  console.log(`[HERMES:#${seq}][${category}:${event}] session=${sessionId}`, {
    ts: ts.toFixed(2),
    payload,
    charCodes,
    ...extra,
  });

  // Notify subscribers (debug panel)
  for (const sub of subscribers) {
    try { sub(entry); } catch { /* ignore subscriber errors */ }
  }

  return entry;
}

// ─── Queries ────────────────────────────────────────────────────────

export function getEvents(): readonly DiagnosticEvent[] {
  return events;
}

export function getEventsBySession(sessionId: string): DiagnosticEvent[] {
  return events.filter(e => e.sessionId === sessionId);
}

export function getEventsByCategory(category: EventCategory): DiagnosticEvent[] {
  return events.filter(e => e.category === category);
}

export function clearEvents(): void {
  events.length = 0;
}

export function exportEventsJSON(): string {
  return JSON.stringify(events, null, 2);
}

// ─── Subscriptions (for debug panel live updates) ───────────────────

export function subscribe(cb: (event: DiagnosticEvent) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

// ─── Convenience recorders ──────────────────────────────────────────

export function recordInput(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("INPUT", event, sessionId, data, extra);
}

export function recordTerminal(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("TERMINAL", event, sessionId, data, extra);
}

export function recordPty(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("PTY", event, sessionId, data, extra);
}

export function recordContext(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("CONTEXT", event, sessionId, data, extra);
}

export function recordShortcut(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("SHORTCUT", event, sessionId, data, extra);
}

export function recordMount(event: string, sessionId: string, data: unknown, extra?: Record<string, unknown>) {
  return record("MOUNT", event, sessionId, data, extra);
}

export function recordWindow(event: string, data: unknown, extra?: Record<string, unknown>) {
  return record("WINDOW", event, "*", data, extra);
}
