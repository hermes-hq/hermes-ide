// ─── The agent's first output after a person answered ─────────────────
//
// F10 x F11 (deriveStatus, rule 6). The terminal guesses "working" only when
// output starts after a quiet spell, so a person who answers an OSC-only
// agent's approval box before the terminal went quiet (within about two
// seconds) never gets a new working guess, and the "needs approval" signal
// would stay. This closes that gap: the first visible output after the
// person's keys, while the session still shows a signal, is the terminal's
// working guess (source "pty", guessed), the same event the terminal
// provider sends on a phase change.

import { dispatchSessionEvent } from "../contract/sessionEventStore";
import { getSessionStatus } from "./attentionStore";
import { PTY_SOURCE } from "./deriveStatus";
import { clearInputAwaitingOutput, inputAwaitingOutput } from "./userInput";

const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]/g;
const VISIBLE = /[^\s\x00-\x1f\x7f]/;

/** Whether a chunk of terminal output shows any text (not only escapes and whitespace). */
export function hasVisibleText(bytes: Uint8Array): boolean {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return VISIBLE.test(text.replace(ESCAPES, ""));
}

/** A chunk of the session's terminal output arrived at `at`. */
export function noteSessionOutput(sessionId: string, bytes: Uint8Array, at: number = Date.now()): void {
  if (inputAwaitingOutput(sessionId) === null || !hasVisibleText(bytes)) return;
  clearInputAwaitingOutput(sessionId);
  if (getSessionStatus(sessionId).confidence !== "signal") return;
  dispatchSessionEvent(sessionId, { type: "status", at, source: PTY_SOURCE, status: { kind: "working", confidence: "guessed", detail: "" } });
}
