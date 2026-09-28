// ─── Session providers: where a session's events come from ────────────
//
// F19 (docs/adr/004-2.0-contracts.md §2). Every session has a provider that
// turns what it can observe into SessionEvents; the rest of Hermes (status,
// inbox, ledger, plugins) reads only those events.
//
//   terminal   — every terminal session, whatever runs in it: the PTY's
//                phase heuristics (guessed) and the launch helper's startup
//                states (exact, or guessed for its timeout).
//   agent-view — the optional structured view: its protocol events (exact).
//
// Agent hooks and OSC notifications (F11) arrive from Rust on the session
// event channel and join the same store; they are not a provider object here.
//
// This folder is the only place allowed to branch on an agent's id
// (eslint rule hermes/no-vendor-id-checks).

import type { SessionEvent } from "../contract/events";
import type { Confidence } from "../contract/status";

export interface ProviderCapabilities {
  /** The best confidence this provider's statuses carry. */
  readonly status: Confidence;
  /** Can it tell that the agent waits on an approval? */
  readonly approvals: boolean;
  /** Can it tell that the agent asked a question? */
  readonly questions: boolean;
  /** Does it report turn boundaries (turn_start / turn_end)? */
  readonly turnBoundaries: boolean;
  /** Does it report the agent's own session id, model or permission mode? */
  readonly identity: boolean;
}

/**
 * A provider is pure: given what it saw before and what it sees now, it
 * returns the events in between. The registry below remembers the last
 * observation per session and sends the events to the store.
 */
export interface SessionProvider<Observation> {
  readonly id: string;
  /** The `source` its events carry. */
  readonly source: string;
  readonly capabilities: ProviderCapabilities;
  observe(prev: Observation | null, next: Observation, at: number): SessionEvent[];
}

export type EventSink = (sessionId: string, event: SessionEvent) => void;

/** Keeps the last observation of each session and forwards the difference. */
export class ProviderRegistry<Observation> {
  private readonly last = new Map<string, Observation>();

  constructor(
    readonly provider: SessionProvider<Observation>,
    private readonly sink: EventSink,
  ) {}

  /** Returns the events sent, for tests and logs. */
  observe(sessionId: string, observation: Observation, at: number): SessionEvent[] {
    const prev = this.last.get(sessionId) ?? null;
    this.last.set(sessionId, observation);
    const events = this.provider.observe(prev, observation, at);
    for (const event of events) this.sink(sessionId, event);
    return events;
  }

  has(sessionId: string): boolean {
    return this.last.has(sessionId);
  }

  ids(): string[] {
    return [...this.last.keys()];
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}

/** Identity fields, or null when there is nothing to say. */
export interface IdentityFields {
  readonly vendorSessionId: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
}

export function sameIdentity(a: IdentityFields | null, b: IdentityFields): boolean {
  return !!a && a.vendorSessionId === b.vendorSessionId && a.model === b.model && a.permissionMode === b.permissionMode;
}

export function hasIdentity(i: IdentityFields): boolean {
  return i.vendorSessionId !== null || i.model !== null || i.permissionMode !== null;
}
