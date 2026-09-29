// ─── SessionEvent: what a session reports, whatever the agent ────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). Rust emits these on one
// Tauri channel (see channel.ts); the frontend keeps them per session in
// sessionEventStore.ts. Every event carries `at` (epoch ms) and an optional
// `source` naming where it came from ("hook", "osc", "pty", "plugin:<id>",
// "e2e"). Later features may only ADD variants or optional fields.

import { parseAgentStatus, type AgentStatus } from "./status";

interface EventBase {
  /** Epoch milliseconds when the event happened. */
  readonly at: number;
  /** Where it came from; free text, for people and logs. */
  readonly source?: string;
  /**
   * Machine markers found in what the agent reported (F21, additive): a
   * `[hermes-review #3]` line pasted into the agent's prompt comes back as
   * `hermes-review#3`. Never text for people. Absent when there are none.
   */
  readonly tags?: readonly string[];
}

export interface StatusEvent extends EventBase {
  readonly type: "status";
  readonly status: AgentStatus;
}

export interface TurnStartEvent extends EventBase {
  readonly type: "turn_start";
  /** 1-based turn number within the session. */
  readonly n: number;
}

export interface TurnEndEvent extends EventBase {
  readonly type: "turn_end";
  readonly n: number;
}

export interface TurnFailedEvent extends EventBase {
  readonly type: "turn_failed";
  readonly n: number;
  readonly detail: string;
}

export interface TurnInterruptedEvent extends EventBase {
  readonly type: "turn_interrupted";
  readonly n: number;
}

/** The agent wants a person: an approval, a question, a notification. */
export interface AttentionEvent extends EventBase {
  readonly type: "attention";
  readonly detail: string;
}

/** What the agent says about itself. Unknown parts are null. */
export interface IdentityEvent extends EventBase {
  readonly type: "identity";
  readonly vendorSessionId: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
}

export interface ExitEvent extends EventBase {
  readonly type: "exit";
  readonly code: number | null;
  readonly signal: string | null;
}

/** F11 (additive): how many sub-agents the agent has running right now. */
export interface SubagentsEvent extends EventBase {
  readonly type: "subagents";
  readonly running: number;
}

/**
 * What the agent itself reports about its usage, as totals for the session
 * so far (F31). Only an agent's own numbers travel here — a transcript, a
 * protocol result, a hook payload — never an estimate made by Hermes. A part
 * the agent does not report is null, and stays "n/a" wherever it is shown.
 * Totals, not deltas: a repeated or late event can never double-count.
 */
export interface UsageEvent extends EventBase {
  readonly type: "usage";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** US dollars, only when the vendor itself reports a cost. */
  readonly costUsd: number | null;
}

/**
 * N19 (an addition to C0): the agent hit, or left, its vendor's usage
 * limit. A `limited` travels together with a `status` event of kind
 * `limited`; this one carries what the status cannot: when the vendor says
 * the limit resets (epoch ms, null when it did not say) and which limit it
 * was ("five_hour", "seven_day"...), both as the vendor reported them.
 */
export interface LimitEvent extends EventBase {
  readonly type: "limit";
  readonly state: "limited" | "cleared";
  readonly resetsAt: number | null;
  readonly window: string | null;
}

export type SessionEvent =
  | StatusEvent
  | TurnStartEvent
  | TurnEndEvent
  | TurnFailedEvent
  | TurnInterruptedEvent
  | AttentionEvent
  | IdentityEvent
  | ExitEvent
  | SubagentsEvent
  | UsageEvent
  | LimitEvent;

export type SessionEventType = SessionEvent["type"];

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "status",
  "turn_start",
  "turn_end",
  "turn_failed",
  "turn_interrupted",
  "attention",
  "identity",
  "exit",
  "subagents",
  "usage",
  "limit",
];

function optionalString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
}

/** The largest turn number: the Rust side reads `n` as a NonZeroU32. */
const MAX_TURN_NUMBER = 4294967295;

/** A whole number of tokens, or null; undefined when malformed. */
function optionalTokens(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** A finite, non-negative amount of dollars, or null; undefined when malformed. */
function optionalUsd(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function turnNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_TURN_NUMBER ? v : null;
}

/**
 * Validating parser for an event off the wire (Rust, a plugin, the e2e
 * injector). Returns null for anything malformed: an unknown type, a
 * missing field, a wrong type. Extra fields are dropped, so a newer
 * producer never breaks an older reader. Numbers are bounded like the
 * Rust side (`at` an integer JavaScript holds exactly, `n` 1..=u32::MAX,
 * `code` an i32) so both parsers agree.
 */
export function parseSessionEvent(value: unknown): SessionEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at)) return null;
  const source = v.source === undefined ? undefined : v.source;
  if (source !== undefined && typeof source !== "string") return null;
  const tags = v.tags === undefined || v.tags === null ? undefined : v.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) return null;
  const base: EventBase = {
    at: v.at,
    ...(source === undefined ? {} : { source }),
    ...(tags === undefined ? {} : { tags: [...(tags as string[])] }),
  };

  switch (v.type) {
    case "status": {
      const status = parseAgentStatus(v.status);
      return status ? { ...base, type: "status", status } : null;
    }
    case "turn_start":
    case "turn_end":
    case "turn_interrupted": {
      const n = turnNumber(v.n);
      return n === null ? null : { ...base, type: v.type, n };
    }
    case "turn_failed": {
      const n = turnNumber(v.n);
      if (n === null || typeof v.detail !== "string") return null;
      return { ...base, type: "turn_failed", n, detail: v.detail };
    }
    case "attention":
      return typeof v.detail === "string" ? { ...base, type: "attention", detail: v.detail } : null;
    case "identity": {
      const vendorSessionId = optionalString(v.vendorSessionId);
      const model = optionalString(v.model);
      const permissionMode = optionalString(v.permissionMode);
      if (vendorSessionId === undefined || model === undefined || permissionMode === undefined) return null;
      return { ...base, type: "identity", vendorSessionId, model, permissionMode };
    }
    case "exit": {
      const code = v.code === undefined || v.code === null ? null : v.code;
      const signal = v.signal === undefined || v.signal === null ? null : v.signal;
      if (code !== null && !(typeof code === "number" && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647)) return null;
      if (signal !== null && typeof signal !== "string") return null;
      return { ...base, type: "exit", code, signal };
    }
    case "subagents": {
      const running = v.running;
      if (typeof running !== "number" || !Number.isInteger(running) || running < 0 || running > 4294967295) return null;
      return { ...base, type: "subagents", running };
    }
    case "usage": {
      const inputTokens = optionalTokens(v.inputTokens);
      const outputTokens = optionalTokens(v.outputTokens);
      const costUsd = optionalUsd(v.costUsd);
      if (inputTokens === undefined || outputTokens === undefined || costUsd === undefined) return null;
      return { ...base, type: "usage", inputTokens, outputTokens, costUsd };
    }
    case "limit": {
      if (v.state !== "limited" && v.state !== "cleared") return null;
      const resetsAt = v.resetsAt === undefined || v.resetsAt === null ? null : v.resetsAt;
      if (resetsAt !== null && !(typeof resetsAt === "number" && Number.isInteger(resetsAt))) return null;
      const window = optionalString(v.window);
      if (window === undefined) return null;
      return { ...base, type: "limit", state: v.state, resetsAt, window };
    }
    default:
      return null;
  }
}
