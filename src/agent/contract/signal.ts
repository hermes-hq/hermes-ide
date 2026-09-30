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
// (src-tauri/src/contract/signal.rs) watches the spool and emits the events;
// this module is the same parser and mapping for the frontend and for tests.
// The shared fixture fixtures/signal-records.json pins the mapping on both
// sides, per agent (Claude, Codex, Gemini, Copilot, Antigravity, goose,
// OpenCode).

import type { SessionEvent } from "./events";
import type { AgentStatusKind, Confidence } from "./status";

export const SIGNAL_RECORD_VERSION = 1;
/** `hi signal` caps the payload it writes at 8 KB. */
export const SIGNAL_PAYLOAD_CAP_BYTES = 8 * 1024;

export interface SignalRecord {
  readonly v: 1;
  /** Epoch seconds, as `date +%s` prints it. */
  readonly ts: number;
  /** Epoch milliseconds, when the writer knows them (`hi` does). */
  readonly ts_ms?: number;
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
      ...(typeof r.ts_ms === "number" && Number.isFinite(r.ts_ms) ? { ts_ms: r.ts_ms } : {}),
      session: r.session as string,
      agent: r.agent as string,
      nonce: r.nonce as string,
      event: r.event as string,
      payload: payload as Record<string, unknown>,
    },
  };
}

/**
 * When the event happened, epoch ms: `ts_ms` when given and it agrees with
 * `ts` to the second, else `ts`. Mirrors `SignalRecord::at_ms`.
 */
export function signalRecordAt(record: SignalRecord): number {
  const ms = record.ts_ms;
  if (typeof ms === "number" && Number.isInteger(ms) && Math.floor(ms / 1000) === record.ts) return ms;
  return Math.round(record.ts * 1000);
}

/**
 * The tools an agent asks the person a question with (Claude's
 * AskUserQuestion, Codex's request_user_input, Antigravity's ask_question):
 * their use means "needs an answer", not "needs approval".
 */
export function isQuestionTool(name: string | null): boolean {
  return name === "AskUserQuestion" || name === "request_user_input" || name === "ask_question";
}

/**
 * Vendor event name -> status, by the name alone. Null: not a status by
 * itself, or one that depends on the payload (see mapSignalRecord).
 */
export function signalStatusKind(event: string): AgentStatusKind | null {
  switch (event) {
    case "UserPromptSubmit":
    case "BeforeAgent":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PostToolBatch":
    case "PermissionDenied":
    case "PreToolUse":
    case "session.status":
    case "PreInvocation":
    case "PostInvocation":
      return "working";
    case "PermissionRequest":
    case "permission.asked":
      return "needs_approval";
    case "AskUserQuestion":
    case "Question":
      return "needs_answer";
    case "ExitPlanMode":
      return "plan_ready";
    case "Stop":
    case "AfterAgent":
    case "agentStop":
    case "agent-turn-complete":
    case "TurnEnd":
    case "session.idle":
      return "done_unread";
    case "StopFailure":
    case "errorOccurred":
    case "ErrorOccurred":
    case "Failure":
    case "Error":
    case "session.error":
      return "error";
    case "SessionEnd":
    case "hermes.exited":
      return "exited";
    case "hermes.resume_fallback":
      return "starting";
    case "SessionStart":
      return "idle";
    default:
      return null;
  }
}

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The model the agent says it runs (`model`, or Antigravity's `modelName`). Mirrors `reported_model`. */
export function reportedModel(payload: Record<string, unknown>): string | null {
  const m = payloadStr(payload, "model") ?? payloadStr(payload, "modelName");
  return m === null ? null : m.slice(0, 200);
}

const cap = (s: string): string => s.slice(0, 200);

function detailOf(payload: Record<string, unknown>): string {
  for (const key of ["message", "tool_name", "toolName", "question", "reason"]) {
    const v = payloadStr(payload, key);
    if (v !== null) return cap(v);
  }
  return "";
}

function errorDetail(payload: Record<string, unknown>): string {
  for (const key of ["error", "message", "reason"]) {
    const v = payloadStr(payload, key);
    if (v !== null) return cap(v);
  }
  return "";
}

/** The agent's own conversation id, whatever the vendor calls it. */
export function vendorSessionIdOf(payload: Record<string, unknown>): string | null {
  for (const key of ["session_id", "sessionId", "thread-id", "thread_id", "conversationId", "vendor_session_id"]) {
    const v = payloadStr(payload, key);
    if (v !== null) return v;
  }
  return null;
}

/** +1 for a sub-agent starting, -1 for one stopping, 0 otherwise. */
export function subagentDelta(record: SignalRecord): number {
  switch (record.event) {
    case "SubagentStart":
    case "subagentStart":
      return 1;
    case "SubagentStop":
    case "subagentStop":
      return -1;
    default:
      return 0;
  }
}

function notificationStatus(payload: Record<string, unknown>): AgentStatusKind | null {
  switch (payloadStr(payload, "notification_type")) {
    case "permission_prompt":
    case "ToolPermission":
      return "needs_approval";
    case "elicitation_dialog":
    case "elicitation_url_dialog":
    case "agent_needs_input":
      return "needs_answer";
    case "agent_completed":
      return "done_unread";
    default:
      return null;
  }
}

/**
 * Machine markers Hermes put into text the agent now reports back, in the
 * form `[hermes-<name> #<n>]` (for example the `[hermes-review #3]` line a
 * person pastes from the Review Desk, F21). Returned as `hermes-<name>#<n>`,
 * deduplicated, in order of appearance. Never the surrounding text. The
 * Rust mirror is `contract::signal::tags_in_text`.
 */
export function tagsInText(text: string): string[] {
  const out: string[] = [];
  const re = /\[(hermes-[A-Za-z0-9_-]+) #(\d{1,9})\]/g;
  for (const m of text.matchAll(re)) {
    const tag = `${m[1]}#${m[2]}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The field `hi signal` lifts the markers into (the prompt itself never reaches the spool). */
const TAGS_FIELD = "hermes_tags";
const TAG_SHAPE = /^hermes-[A-Za-z0-9_-]+#\d{1,9}$/;

/**
 * The markers of a payload: the `hermes_tags` list `hi` wrote, plus
 * `tagsInText` over any string value still present. Deduplicated.
 */
export function tagsInPayload(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (tag: string) => {
    if (!out.includes(tag)) out.push(tag);
  };
  const listed = payload[TAGS_FIELD];
  if (Array.isArray(listed)) for (const item of listed) if (typeof item === "string" && TAG_SHAPE.test(item)) push(item);
  for (const [key, value] of Object.entries(payload)) {
    if (key === TAGS_FIELD || typeof value !== "string") continue;
    for (const tag of tagsInText(value)) push(tag);
  }
  return out;
}

/**
 * Every event a nonce-verified record means: an `identity` when the record
 * names the vendor's conversation, then the status, attention or exit it
 * stands for. Empty when the nonce does not match or the event carries no
 * meaning for Hermes. `confidence` is the agent's (catalog
 * `signals.confidence`); `source` names where the record came from. The
 * status, attention or exit carries the payload's `tags` (F21) when it has any.
 * Mirrors `map_signal_record` in src-tauri/src/contract/signal.rs.
 */
export function mapSignalRecord(record: SignalRecord, expectedNonce: string, confidence: Confidence, source: string): SessionEvent[] {
  if (record.nonce !== expectedNonce) return [];
  const at = signalRecordAt(record);
  const payload = record.payload;
  const status = (kind: AgentStatusKind, detail: string): SessionEvent => ({ type: "status", at, source, status: { kind, confidence, detail } });
  const out: SessionEvent[] = [];
  if (record.event === "SessionStart" || record.event === "hermes.resume_fallback" || record.event === "agent-turn-complete") {
    const vendorSessionId = vendorSessionIdOf(payload);
    const permissionMode = payloadStr(payload, "permission_mode");
    const model = reportedModel(payload);
    if (vendorSessionId !== null || permissionMode !== null || model !== null) {
      out.push({ type: "identity", at, source, vendorSessionId, model, permissionMode });
    }
  }
  let primary: SessionEvent;
  switch (record.event) {
    case "PreToolUse": {
      const tool = payloadStr(payload, "tool_name");
      primary = isQuestionTool(tool) ? status("needs_answer", detailOf(payload)) : tool === "ExitPlanMode" ? status("plan_ready", "") : status("working", "");
      break;
    }
    // Claude asks permission for its question and plan tools too: what the
    // person is asked is still a question, or a plan.
    case "PermissionRequest": {
      const tool = payloadStr(payload, "tool_name");
      primary = isQuestionTool(tool) ? status("needs_answer", detailOf(payload)) : tool === "ExitPlanMode" ? status("plan_ready", "") : status("needs_approval", detailOf(payload));
      break;
    }
    case "Notification": {
      const kind = notificationStatus(payload);
      primary = kind ? status(kind, detailOf(payload)) : { type: "attention", at, source, detail: detailOf(payload) };
      break;
    }
    case "hermes.exited": {
      const raw = payload.exit_code;
      const code = typeof raw === "number" && Number.isInteger(raw) && raw >= -2147483648 && raw <= 2147483647 ? raw : null;
      primary = { type: "exit", at, source, code, signal: null };
      break;
    }
    default: {
      // Antigravity's Stop fires after every execution: only `fullyIdle`
      // means the turn is over, and `error` means it failed.
      if (record.event === "Stop" && ("fullyIdle" in payload || "error" in payload)) {
        primary = payloadStr(payload, "error") !== null ? status("error", errorDetail(payload)) : payload.fullyIdle === false ? status("working", "") : status("done_unread", "");
        break;
      }
      const kind = signalStatusKind(record.event);
      if (kind === null) return out;
      if (kind === "exited") primary = { type: "exit", at, source, code: null, signal: null };
      else if (kind === "error") primary = status("error", errorDetail(payload));
      else if (kind === "needs_approval" || kind === "needs_answer") primary = status(kind, detailOf(payload));
      else primary = status(kind, "");
    }
  }
  // F21: machine markers in what the agent reported ride on the event
  // they came with (never on the identity).
  const tags = tagsInPayload(payload);
  out.push(tags.length > 0 ? { ...primary, tags } : primary);
  return out;
}

/**
 * The one SessionEvent a record means (its status, attention or exit; never
 * the identity), with `exact` confidence, or null when the nonce does not
 * match or the event carries no meaning for Hermes.
 */
export function signalRecordToSessionEvent(record: SignalRecord, expectedNonce: string): SessionEvent | null {
  return mapSignalRecord(record, expectedNonce, "exact", `hook:${record.agent}`).find((e) => e.type !== "identity") ?? null;
}
