// ─── `hi signal` spool records ────────────────────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). The `hi signal` helper (F11)
// appends ONE JSON line per agent hook event to the session's spool file:
//
//   {"v":1,"ts":1790000000,"session":"<sid>","agent":"claude",
//    "nonce":"<nonce>","event":"PermissionRequest","payload":{...}}
//
// The nonce is minted by Hermes per launch and handed to the agent's hook
// configuration; a record whose nonce does not match is not `exact` — it is
// text any program could have written. The Rust mirror
// (src-tauri/src/contract/signal.rs) watches the spool; this module is the
// same parser and mapping for the frontend and for tests.
//
// `signalRecordToSessionEvent` is a STUB: it covers the status map from the
// signals report; F11 owns the per-agent event names.

import type { SessionEvent } from "./events";
import type { AgentStatusKind } from "./status";

export const SIGNAL_RECORD_VERSION = 1;
/** `hi signal` caps the payload it writes at 8 KB. */
export const SIGNAL_PAYLOAD_CAP_BYTES = 8 * 1024;

export interface SignalRecord {
  readonly v: 1;
  /** Epoch seconds, as `date +%s` prints it. */
  readonly ts: number;
  /** Hermes session id the hook was configured for. */
  readonly session: string;
  /** Catalog agent id: claude, codex, gemini, copilot, opencode, goose... */
  readonly agent: string;
  readonly nonce: string;
  /** The agent's own event name, as it names it (PermissionRequest, Stop...). */
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

export type SignalParse = { ok: true; record: SignalRecord } | { ok: false; error: string };

/** Parse one spool line. Never throws. */
export function parseSignalRecord(line: string): SignalParse {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;
  if (r.v !== SIGNAL_RECORD_VERSION) return { ok: false, error: `unsupported version ${String(r.v)}` };
  for (const key of ["session", "agent", "nonce", "event"] as const) {
    if (typeof r[key] !== "string" || r[key] === "") return { ok: false, error: `missing ${key}` };
  }
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return { ok: false, error: "missing ts" };
  const payload = r.payload === undefined ? {} : r.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload is not an object" };
  return {
    ok: true,
    record: {
      v: 1,
      ts: r.ts,
      session: r.session as string,
      agent: r.agent as string,
      nonce: r.nonce as string,
      event: r.event as string,
      payload: payload as Record<string, unknown>,
    },
  };
}

/** Vendor event name -> status, from the signals report. Null: not a status. */
export function signalStatusKind(event: string): AgentStatusKind | null {
  switch (event) {
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PreToolUse":
      return "working";
    case "PermissionRequest":
      return "needs_approval";
    case "Notification":
      // Claude's Notification carries a "permission_prompt" or an
      // "idle_prompt"; without the payload the event alone is attention.
      return null;
    case "AskUserQuestion":
    case "Question":
      return "needs_answer";
    case "ExitPlanMode":
      return "plan_ready";
    case "Stop":
    case "AfterAgent":
    case "TurnEnd":
      return "done_unread";
    case "Failure":
    case "Error":
      return "error";
    case "SessionEnd":
      return "exited";
    default:
      return null;
  }
}

function detailOf(payload: Record<string, unknown>): string {
  for (const key of ["message", "tool_name", "toolName", "question", "reason"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 200);
  }
  return "";
}

/**
 * Map a spool record to the SessionEvent it means, or null when the nonce
 * does not match (the line is untrusted text) or the event carries no
 * meaning for Hermes yet. Stub: F11 extends the table per agent.
 */
export function signalRecordToSessionEvent(record: SignalRecord, expectedNonce: string): SessionEvent | null {
  if (record.nonce !== expectedNonce) return null;
  const at = Math.round(record.ts * 1000);
  const source = `hook:${record.agent}`;
  const kind = signalStatusKind(record.event);
  if (kind === "exited") return { type: "exit", at, source, code: null, signal: null };
  if (kind) {
    return { type: "status", at, source, status: { kind, confidence: "exact", detail: detailOf(record.payload) } };
  }
  if (record.event === "Notification") return { type: "attention", at, source, detail: detailOf(record.payload) };
  return null;
}
