// ─── "Use in session": put text where the person sends from ──────────
//
// A terminal session (any agent, any shell) gets the text as one bracketed
// paste and no Enter: the person reads it and presses Enter themselves. Only
// when the person asks to send (Insert and send) does an Enter follow. An
// Agent-view session gets it in its message box, never sent.
//
// A program that has not asked for bracketed paste (DECSET 2004) would run
// each line of a multi-line paste as it arrives, so such text goes to the
// clipboard instead.

import { writeToSession } from "../api/sessions";
import { clearGhostText, dismissSuggestions, getTerminal } from "../terminal/TerminalPool";
import { utf8ToBase64 } from "../utils/encoding";

/** The bytes of one bracketed paste of `text`, with no Enter after it. */
export function pasteBytes(text: string): string {
  // A paste must not end its own bracket early.
  const safe = text.replace(/\x1b\[201~/g, "");
  return `\x1b[200~${safe}\x1b[201~`;
}

export interface SessionTarget {
  id: string;
  mode: "terminal" | "agent";
  /** The Agent view's current draft (appended to, never replaced). */
  draft?: string;
}

export interface PlaceOptions {
  /**
   * One short line typed before the paste (no Enter), for an agent that acts
   * on a folded paste only when the typed message asks it to.
   */
  lead?: string | null;
  /** Press Enter after the text (the person asked to send). */
  send?: boolean;
}

/** How long the agent gets to take in a paste before the Enter that sends it. */
export const SEND_AFTER_PASTE_MS = 120;

export interface PlaceDeps {
  setDraft(sessionId: string, draft: string): void;
  write(sessionId: string, base64: string): Promise<void>;
  /** Whether the program in the terminal accepts a bracketed paste; null when unknown. */
  bracketed(sessionId: string): boolean | null;
  copy(text: string): Promise<void>;
  /** Waits before the Enter (tests pass a no-op). */
  wait?(ms: number): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type PlaceResult = "draft" | "pasted" | "sent" | "copied" | "empty";

export async function placeInSession(target: SessionTarget, text: string, deps: PlaceDeps = defaultDeps, opts: PlaceOptions = {}): Promise<PlaceResult> {
  const body = text.trim();
  if (!body) return "empty";
  if (target.mode === "agent") {
    const existing = target.draft ?? "";
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
    deps.setDraft(target.id, existing + sep + body);
    return "draft";
  }
  const bracketed = deps.bracketed(target.id);
  if (bracketed === false && body.includes("\n")) {
    await deps.copy(body);
    return "copied";
  }
  // The lead line is typed (outside the paste brackets) so the agent reads it as the person's own message.
  const lead = opts.lead?.replace(/[\r\n]+/g, " ").trim();
  const typed = lead && bracketed !== false ? `${lead} ` : "";
  await deps.write(target.id, utf8ToBase64(typed + (bracketed === false ? body : pasteBytes(body))));
  if (!opts.send) return "pasted";
  await (deps.wait ?? wait)(SEND_AFTER_PASTE_MS);
  await deps.write(target.id, utf8ToBase64("\r"));
  return "sent";
}

const defaultDeps: PlaceDeps = {
  setDraft: () => {},
  write: async (sessionId, base64) => {
    dismissSuggestions(sessionId);
    clearGhostText(sessionId);
    await writeToSession(sessionId, base64);
  },
  bracketed: (sessionId) => getTerminal(sessionId)?.modes.bracketedPasteMode ?? null,
  copy: (text) => navigator.clipboard.writeText(text),
};

export function sessionDeps(setDraft: PlaceDeps["setDraft"]): PlaceDeps {
  return { ...defaultDeps, setDraft };
}
