// ─── How a status looks: a glyph and a word, never colour alone ───────
//
// F10. Every AgentStatus kind has its own glyph (a plain text character, so
// it reads the same in every theme and to a screen reader skipping it) and
// its own word from the language packs. Colour is a third cue on top, never
// the only one. A `guessed` status renders dimmed with the word "guessed".

import { AGENT_STATUS_KINDS, type AgentStatusKind, type Confidence } from "../contract/status";

/** One distinct text glyph per status. No emoji: they render as pictures. */
export const STATUS_GLYPHS: Readonly<Record<AgentStatusKind, string>> = Object.freeze({
  needs_approval: "!",
  needs_answer: "?",
  gate: "◇",
  check_failed: "⊘",
  error: "✕",
  limited: "◔",
  plan_ready: "≡",
  done_unread: "●",
  working: "◐",
  startup_prompt: "⋯",
  starting: "○",
  idle: "–",
  exited: "■",
});

/**
 * Colour family, the third cue:
 *   attention — a person has to act (the blocking kinds)
 *   ready     — something finished and is waiting to be looked at
 *   active    — the agent is busy or coming up
 *   quiet     — nothing is happening
 */
export type StatusTone = "attention" | "ready" | "active" | "quiet";

export const STATUS_TONES: Readonly<Record<AgentStatusKind, StatusTone>> = Object.freeze({
  needs_approval: "attention",
  needs_answer: "attention",
  gate: "attention",
  check_failed: "attention",
  error: "attention",
  limited: "attention",
  plan_ready: "ready",
  done_unread: "ready",
  working: "active",
  startup_prompt: "attention",
  starting: "active",
  idle: "quiet",
  exited: "quiet",
});

/** The language-pack key of a status's word. */
export function statusWordKey(kind: AgentStatusKind): string {
  return `agentStatus.${kind}`;
}

/** The language-pack key explaining a confidence (used in the tooltip). */
export function confidenceKey(confidence: Confidence): string {
  return `agentStatus.confidence.${confidence}`;
}

export const GUESSED_WORD_KEY = "agentStatus.guessed";

/** Every key this module needs, for the language-pack tests. */
export const STATUS_MESSAGE_KEYS: readonly string[] = [
  ...AGENT_STATUS_KINDS.map(statusWordKey),
  confidenceKey("exact"),
  confidenceKey("signal"),
  confidenceKey("guessed"),
  GUESSED_WORD_KEY,
];

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface StatusLabel {
  readonly glyph: string;
  readonly word: string;
  readonly tone: StatusTone;
  /** "guessed" (translated) for a guessed status, else null. */
  readonly guessed: string | null;
  /** The tooltip: the detail line, then how sure Hermes is. */
  readonly title: string;
}

export interface StatusLabelInput {
  readonly kind: AgentStatusKind;
  readonly confidence: Confidence;
  readonly detail: string;
  /** For `exited`: the process's code and signal, worded by the renderer. */
  readonly exit?: { readonly code: number | null; readonly signal: string | null } | null;
}

/** Everything a status tag shows, in the person's language. */
export function statusLabel(status: StatusLabelInput, t: Translate): StatusLabel {
  let detail = status.detail.trim();
  if (status.kind === "exited" && detail === "" && status.exit) {
    if (status.exit.signal) detail = t("agentError.exitSignal", { signal: status.exit.signal });
    else if (status.exit.code !== null) detail = t("agentError.exitCode", { code: status.exit.code });
  }
  const sure = t(confidenceKey(status.confidence));
  return {
    glyph: STATUS_GLYPHS[status.kind],
    word: t(statusWordKey(status.kind)),
    tone: STATUS_TONES[status.kind],
    guessed: status.confidence === "guessed" ? t(GUESSED_WORD_KEY) : null,
    title: detail ? `${detail}\n${sure}` : sure,
  };
}
