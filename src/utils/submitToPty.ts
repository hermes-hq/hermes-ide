import { writeToSession } from "../api/sessions";
import {
  dismissSuggestions,
  clearGhostText,
  getInputBufferLength,
  clearInputBuffer,
} from "../terminal/TerminalPool";

/**
 * Submit text to a session's PTY as a bracketed paste, then a CR.
 *
 * Mirrors how a user would paste into xterm: clears the shell's current input
 * line first (so any in-flight typed chars don't concatenate), then sends the
 * text framed in `\x1b[200~`/`\x1b[201~` so multi-line content is treated as
 * a single paste, then `\r` to submit.
 *
 * Awaits the write so the caller can sequence post-write actions (e.g. clearing
 * a draft, closing a modal) only after the bytes have reached the PTY mutex.
 */
export async function submitToPty(sessionId: string, text: string): Promise<void> {
  dismissSuggestions(sessionId);
  clearGhostText(sessionId);

  const eraseLen = getInputBufferLength(sessionId);
  clearInputBuffer(sessionId);
  const backspaces = eraseLen > 0 ? "\x7f".repeat(eraseLen) : "";

  const payload = backspaces + "\x1b[200~" + text + "\x1b[201~" + "\r";
  const bytes = new TextEncoder().encode(payload);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const data = btoa(binary);

  await writeToSession(sessionId, data);
}
