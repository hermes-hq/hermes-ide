// ─── Session status strip ─────────────────────────────────────────────
//
// F11: one line above a terminal agent session that says what the agent
// is doing and how Hermes knows: the status (needs approval, working,
// done, ...), its source and confidence (hook, exact / notification,
// signal / guessed), the number of running sub-agents, and the inbox
// shortcut hint (⌘I on macOS, Ctrl+I elsewhere) for the attention inbox.
// It reads the per-session event store only (docs/adr/004-2.0-contracts.md)
// and never touches the terminal: with the strip on or off the agent's
// output is the same bytes.
//
// Before any signal arrives the strip shows a guess from the session
// phase, dimmed, so a session is never labelled with a certainty it does
// not have.

import { PTY_SOURCE, resumedIndex } from "../agent/status/deriveStatus";
import { userInputTimes } from "../agent/status/userInput";
import "../styles/components/SessionStatusStrip.css";
import { useSessionEvents, type SessionEventSnapshot } from "../agent/contract/sessionEventStore";
import type { AgentStatus, AgentStatusKind, Confidence } from "../agent/contract/status";
import { useI18n } from "../i18n/I18nProvider";
import { fmt } from "../utils/platform";

/** The attention inbox shortcut as this platform writes it (⌘I / Ctrl+I). */
export const INBOX_SHORTCUT = fmt("{mod}I");

/** One glyph per status kind; the word next to it carries the meaning. */
export const STATUS_GLYPHS: Readonly<Record<AgentStatusKind, string>> = {
  needs_approval: "◆",
  needs_answer: "?",
  gate: "⏸",
  check_failed: "✗",
  error: "✗",
  limited: "⏳",
  plan_ready: "▤",
  done_unread: "●",
  working: "…",
  startup_prompt: "⏸",
  starting: "…",
  idle: "○",
  exited: "○",
};

/** Where the current status came from, for the strip's source label. */
export type StatusSource = "hook" | "osc" | "stream" | "e2e" | "guessed";

/** A guess from the session phase, for a session nothing has signalled. */
export function guessedStatus(phase: string): AgentStatus {
  const kind: AgentStatusKind =
    phase === "busy" ? "working" : phase === "launching_agent" || phase === "creating" || phase === "initializing" ? "starting" : phase === "destroyed" ? "exited" : "idle";
  return { kind, confidence: "guessed", detail: "" };
}

/**
 * The status the strip shows, and where it came from. `inputTimes`: when a
 * person typed into the session (see deriveStatus, rule 6).
 */
export function stripStatus(snapshot: SessionEventSnapshot, phase: string, inputTimes: readonly number[] = []): { status: AgentStatus; source: StatusSource } {
  if (snapshot.version === 0) return { status: guessedStatus(phase), source: "guessed" };
  // The terminal's own heuristics (F10's TerminalProvider, source "pty")
  // never replace what the agent reported: the strip shows the last status
  // from anywhere else (or the exit), and the terminal's guess only while
  // there is none, or once the agent visibly resumed after a signal that
  // the person answered (deriveStatus, rule 6).
  let status: AgentStatus | null = null;
  let raw: string | undefined;
  for (let i = snapshot.events.length - 1; i >= 0; i--) {
    const e = snapshot.events[i];
    if (e.type === "exit" || (e.type === "status" && e.source !== PTY_SOURCE)) {
      status = e.type === "exit" ? { kind: "exited", confidence: "exact", detail: "" } : e.status;
      raw = e.source;
      if (resumedIndex(snapshot.events, i, inputTimes) >= 0) status = null;
      break;
    }
  }
  if (!status) {
    const guess = snapshot.status;
    return { status: guess.confidence === "guessed" ? guess : guessedStatus(phase), source: "guessed" };
  }
  if (status.confidence === "guessed") return { status, source: "guessed" };
  const source: StatusSource = raw?.startsWith("hook:") ? "hook" : raw === "osc" ? "osc" : raw?.startsWith("stream:") ? "stream" : raw === "e2e" ? "e2e" : status.confidence === "signal" ? "osc" : "hook";
  return { status, source };
}

interface SessionStatusStripProps {
  sessionId: string;
  phase: string;
}

export function SessionStatusStrip({ sessionId, phase }: SessionStatusStripProps) {
  const { t } = useI18n();
  const snapshot = useSessionEvents(sessionId);
  const { status, source } = stripStatus(snapshot, phase, userInputTimes(sessionId));
  const confidence: Confidence = status.confidence;
  const guessed = confidence === "guessed";
  const sourceText = guessed ? t("status.source.guessed") : `${t(`status.source.${source}`)}, ${t(`status.confidence.${confidence}`)}`;
  const openInbox = () => {
    window.dispatchEvent(new CustomEvent("hermes:open-inbox", { detail: { sessionId } }));
  };
  return (
    <div
      className={`session-status-strip ${guessed ? "session-status-strip-guessed" : ""}`}
      role="status"
      data-strip-session={sessionId}
      data-status-kind={status.kind}
      data-confidence={confidence}
      data-source={source}
      data-subagents={snapshot.subagents}
    >
      <span className="session-status-strip-glyph" aria-hidden="true">{STATUS_GLYPHS[status.kind]}</span>
      <span className="session-status-strip-word">{t(`status.kind.${status.kind}`)}</span>
      <span className="session-status-strip-sep" aria-hidden="true">·</span>
      <span className="session-status-strip-source">{sourceText}</span>
      {snapshot.subagents > 0 && (
        <>
          <span className="session-status-strip-sep" aria-hidden="true">·</span>
          <span className="session-status-strip-subagents">{t(snapshot.subagents === 1 ? "status.subagentOne" : "status.subagents", { count: snapshot.subagents })}</span>
        </>
      )}
      {status.detail && (
        <span className="session-status-strip-detail" title={status.detail}>{status.detail}</span>
      )}
      <button type="button" className="session-status-strip-inbox" title={t("status.inboxHint", { shortcut: INBOX_SHORTCUT })} onClick={openInbox}>
        {INBOX_SHORTCUT}
      </button>
    </div>
  );
}
