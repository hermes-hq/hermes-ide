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

/**
 * How full the agent's context window is, as the agent itself reports it
 * (F14): the input tokens of its last model call, read from the transcript
 * file it names. `contextLimit` is null when Hermes does not know the
 * model's window; a reader then shows no percentage rather than a guess.
 */
export interface UsageEvent extends EventBase {
  readonly type: "usage";
  readonly usedTokens: number;
  readonly contextLimit: number | null;
  readonly model: string | null;
}

/** The agent compacted its context (F14). Unknown parts are null. */
export interface CompactedEvent extends EventBase {
  readonly type: "compacted";
  /** "auto" or "manual" as the agent says; free text. */
  readonly trigger: string | null;
  /** Tokens in the context just before it was compacted. */
  readonly preTokens: number | null;
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
  | UsageEvent
  | CompactedEvent;

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
  "usage",
  "compacted",
];

function optionalString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
}

/** Largest token count on the wire; the Rust side reads it as a u32. */
const MAX_TOKENS = 4294967295;

/** A token count (an integer 0..u32::MAX), null, or undefined when malformed. */
function tokenCount(v: unknown, { nullable, min }: { nullable: boolean; min: number }): number | null | undefined {
  if (v === undefined || v === null) return nullable ? null : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_TOKENS ? v : undefined;
}

function turnNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Validating parser for an event off the wire (Rust, a plugin, the e2e
 * injector). Returns null for anything malformed: an unknown type, a
 * missing field, a wrong type. Extra fields are dropped, so a newer
 * producer never breaks an older reader. Numbers are bounded like the
 * Rust side (`at` an integer, `code` an i32) so both parsers agree.
 */
export function parseSessionEvent(value: unknown): SessionEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isInteger(v.at)) return null;
  const source = v.source === undefined ? undefined : v.source;
  if (source !== undefined && typeof source !== "string") return null;
  const base: EventBase = source === undefined ? { at: v.at } : { at: v.at, source };

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
    case "usage": {
      const usedTokens = tokenCount(v.usedTokens, { nullable: false, min: 0 });
      const contextLimit = tokenCount(v.contextLimit, { nullable: true, min: 1 });
      const model = optionalString(v.model);
      if (usedTokens === undefined || usedTokens === null || contextLimit === undefined || model === undefined) return null;
      return { ...base, type: "usage", usedTokens, contextLimit, model };
    }
    case "compacted": {
      const trigger = optionalString(v.trigger);
      const preTokens = tokenCount(v.preTokens, { nullable: true, min: 0 });
      if (trigger === undefined || preTokens === undefined) return null;
      return { ...base, type: "compacted", trigger, preTokens };
    }
    default:
      return null;
  }
}
