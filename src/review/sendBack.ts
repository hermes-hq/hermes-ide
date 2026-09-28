// ─── Send-back with a delivery receipt ────────────────────────────────
//
// A terminal agent gets review-<n>.md plus ONE visible tagged line, pasted
// only when the person presses Send (Hermes never types on its own). A
// working agent gets nothing typed into it: a real CLI queues input while
// it works and reports it only when the turn ends, which would look like a
// lost line. So while the session's status (the C0 store) says `working`,
// the send waits; the line is pasted once the status says the turn ended.
// The receipt is the next prompt signal from that session carrying the tag
// — a SessionEvent whose `tags` include `hermes-review#<n>`. Without one in
// RECEIPT_TIMEOUT_MS after the paste the send is "not delivered", and the
// person may retry (the file is already there; only the line is pasted
// again).
//
// The dependencies are injected so the state machine is table-tested
// without a PTY.

import type { SessionEvent } from "../agent/contract/events";
import type { AgentStatus } from "../agent/contract/status";
import { reviewTagId } from "./reviewModel";

export const RECEIPT_TIMEOUT_MS = 5000;

export type DeliveryState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  /** The agent is working; the line is pasted when its turn ends. */
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "delivered"; readonly at: number }
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
 * Write the file, wait for the agent to be free, paste the line, wait for
 * the receipt. Resolves once the outcome is known; `onState` is told about
 * each step on the way.
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

  // Listen before pasting, so a fast agent cannot answer before we look.
  let settle: (state: DeliveryState) => void = () => {};
  const receipt = new Promise<DeliveryState>((resolve) => {
    settle = resolve;
  });
  // The turn's end, when the agent is busy at Send time.
  let free: () => void = () => {};
  const exit: { state: DeliveryState | null } = { state: null };
  const turnEnded = new Promise<void>((resolve) => {
    free = resolve;
  });
  const unsubscribe = deps.onSessionEvent(request.sessionId, (event) => {
    if (isReceiptFor(event, request.n)) settle({ kind: "delivered", at: now() });
    if (event.type === "exit") {
      exit.state = { kind: "failed", reason: "the agent exited before the line could be pasted" };
      free();
    } else if (event.type === "status" && !isBusy(event.status)) {
      free();
    }
  });

  if (isBusy(deps.status(request.sessionId))) {
    onState({ kind: "waiting", reason: "the agent is working; the line is pasted when its turn ends" });
    await turnEnded;
    if (exit.state) {
      unsubscribe();
      onState(exit.state);
      return { state: exit.state, filePath };
    }
    onState({ kind: "sending" });
  }

  const timer = setT(() => settle({ kind: "not_delivered", reason: "the agent did not report the review line" }), timeoutMs);
  try {
    await deps.paste(request.sessionId, request.line(filePath));
  } catch (e) {
    clearT(timer);
    unsubscribe();
    const state: DeliveryState = { kind: "failed", reason: `could not paste into the terminal: ${String(e)}` };
    onState(state);
    return { state, filePath };
  }

  const state = await receipt;
  clearT(timer);
  unsubscribe();
  onState(state);
  return { state, filePath };
}
