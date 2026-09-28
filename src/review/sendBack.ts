// ─── Send-back with a delivery receipt ────────────────────────────────
//
// A terminal agent gets review-<n>.md plus ONE visible tagged line, pasted
// only when the person presses Send (Hermes never types on its own). A
// working agent gets nothing typed into it: a real CLI queues input while
// it works and reports it only when the turn ends, which would look like a
// lost line. So while the session's status (the C0 store) says `working`,
// the send stops at "waiting": the file is written, nothing is pasted, and
// the desk offers "Send now" once the turn has ended — a second explicit
// press, never a paste Hermes decides on later by itself.
//
// The receipt is the next prompt signal from that session carrying the tag
// — a SessionEvent whose `tags` include `hermes-review#<n>`. Only an agent
// whose launch installed a prompt hook can send one (see
// `deliveryReceiptAvailable`); for any other agent the outcome is "pasted"
// — the line went into its terminal and nobody can confirm more — instead
// of a wrong "not delivered". With a receipt possible but none in
// RECEIPT_TIMEOUT_MS after the paste the send is "not delivered", and the
// person may retry (the file is already there; only the line is pasted
// again).
//
// The dependencies are injected so the state machine is table-tested
// without a PTY.

import type { SessionEvent } from "../agent/contract/events";
import type { AgentStatus } from "../agent/contract/status";
import { getAgent } from "../catalog/agentCatalog";
import type { SessionData } from "../types/session";
import { reviewTagId } from "./reviewModel";

export const RECEIPT_TIMEOUT_MS = 5000;

export type DeliveryState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  /** The agent was working at Send time; nothing was pasted. "Send now" pastes it once the turn ended. */
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "delivered"; readonly at: number }
  /** The line was pasted; this agent has no prompt hook, so nothing can confirm it. */
  | { readonly kind: "pasted"; readonly at: number }
  /** A structured agent: the line waits in its composer for the person to send. */
  | { readonly kind: "queued"; readonly reason: string }
  | { readonly kind: "not_delivered"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SendBackDeps {
  /** Writes the review file; resolves with its absolute path. */
  readonly writeFile: (sessionId: string, n: number, content: string) => Promise<string>;
  /** Pastes the one visible line into the session's terminal. */
  readonly paste: (sessionId: string, line: string) => Promise<void>;
  /** Subscribes to the session's events; the callback sees every new event. */
  readonly onSessionEvent: (sessionId: string, listener: (event: SessionEvent) => void) => () => void;
  /** The session's current status from the C0 store. */
  readonly status: (sessionId: string) => AgentStatus;
  /** Whether this session's agent can send the receipt at all (a prompt hook is installed). */
  readonly canConfirm: (sessionId: string) => boolean;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface SendBackRequest {
  readonly sessionId: string;
  readonly n: number;
  readonly content: string;
  /** Builds the pasted line from the written file's path. */
  readonly line: (filePath: string) => string;
}

export interface SendBackOutcome {
  readonly state: DeliveryState;
  readonly filePath: string | null;
}

/** True when this event is the receipt for review n. */
export function isReceiptFor(event: SessionEvent, n: number): boolean {
  return Array.isArray(event.tags) && event.tags.includes(reviewTagId(n));
}

/** True while nothing may be typed into the agent: it is on a turn. */
export function isBusy(status: AgentStatus): boolean {
  return status.kind === "working";
}

/**
 * The launch methods for which the helper installs a prompt-submitted hook
 * (src-tauri/src/pty/launch.rs, `settings_file_json`): only those agents
 * ever send the `[hermes-review #n]` receipt. Keep in step with launch.rs.
 */
const PROMPT_HOOK_METHODS: ReadonlySet<string> = new Set(["settings_file"]);

/**
 * Whether a delivery receipt can come back from this session: the agent was
 * started through the helper (so its hooks are installed) and its vendor
 * takes a prompt hook. A session without one gets "pasted", not a receipt.
 */
export function deliveryReceiptAvailable(session: Pick<SessionData, "ai_provider" | "agent_startup"> | undefined): boolean {
  if (!session || !session.agent_startup) return false;
  const method = getAgent(session.ai_provider)?.terminal?.signals?.method;
  return typeof method === "string" && PROMPT_HOOK_METHODS.has(method);
}

/**
 * Write the file; if the agent is free, paste the line and wait for the
 * receipt (or report "pasted" when none can come). If the agent is working,
 * stop at "waiting" without pasting — the person presses "Send now" later.
 * Resolves once the outcome is known; `onState` is told about each step.
 */
export async function sendReviewBack(
  deps: SendBackDeps,
  request: SendBackRequest,
  onState: (state: DeliveryState) => void = () => {},
): Promise<SendBackOutcome> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  onState({ kind: "sending" });
  let filePath: string;
  try {
    filePath = await deps.writeFile(request.sessionId, request.n, request.content);
  } catch (e) {
    const state: DeliveryState = { kind: "failed", reason: `could not write the review file: ${String(e)}` };
    onState(state);
    return { state, filePath: null };
  }

  if (isBusy(deps.status(request.sessionId))) {
    const state: DeliveryState = { kind: "waiting", reason: "the agent is working; press Send now once its turn has ended" };
    onState(state);
    return { state, filePath };
  }

  const confirmable = deps.canConfirm(request.sessionId);
  // Listen before pasting, so a fast agent cannot answer before we look.
  let settle: (state: DeliveryState) => void = () => {};
  const receipt = new Promise<DeliveryState>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = confirmable
    ? deps.onSessionEvent(request.sessionId, (event) => {
        if (isReceiptFor(event, request.n)) settle({ kind: "delivered", at: now() });
      })
    : () => {};
  const timer = confirmable
    ? setT(() => settle({ kind: "not_delivered", reason: "the agent did not report the review line" }), timeoutMs)
    : null;
  try {
    await deps.paste(request.sessionId, request.line(filePath));
  } catch (e) {
    if (timer !== null) clearT(timer);
    unsubscribe();
    const state: DeliveryState = { kind: "failed", reason: `could not paste into the terminal: ${String(e)}` };
    onState(state);
    return { state, filePath };
  }
  if (!confirmable) {
    const state: DeliveryState = { kind: "pasted", at: now() };
    onState(state);
    return { state, filePath };
  }

  const state = await receipt;
  if (timer !== null) clearT(timer);
  unsubscribe();
  onState(state);
  return { state, filePath };
}
