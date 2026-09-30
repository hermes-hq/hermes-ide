// ─── Session status strip ─────────────────────────────────────────────
//
// F11: one line above a terminal agent session that says what the agent
// is doing and how Hermes knows: the status (needs approval, working,
// done, ...), how sure and who said so ("exact · reported by Claude Code",
// "signal · notification", "guessed", "guessed · process activity"), the
// number of running sub-agents, and the inbox
// shortcut hint (⌘I on macOS, Ctrl+I elsewhere) for the attention inbox.
// It reads the per-session event store only (docs/adr/004-2.0-contracts.md)
// and never touches the terminal: with the strip on or off the agent's
// output is the same bytes.
//
// Before any signal arrives the strip shows a guess from the session
// phase, dimmed, so a session is never labelled with a certainty it does
// not have.

import { OS_SOURCE, foldStatus, isAgentReported, isHelperStartedEcho, isHeuristicSource, resumedIndex } from "../agent/status/deriveStatus";
import { getAgent } from "../catalog/agentCatalog";
import { reporterOfSource } from "../agent/status/presentation";
import { userInputTimes } from "../agent/status/userInput";
import "../styles/components/SessionStatusStrip.css";
import { useSessionEvents, type SessionEventSnapshot } from "../agent/contract/sessionEventStore";
import type { AgentStatus, AgentStatusKind, Confidence } from "../agent/contract/status";
import { useI18n } from "../i18n/I18nProvider";
import { fmt } from "../utils/platform";
import { Button } from "./ui/Button";

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

/**
 * Where the current status came from, for the strip's source label. "os":
 * a guess from the agent's processes (a command running, CPU use); "guessed":
 * any other guess (the screen, the launch helper's wait at a startup prompt).
 */
export type StatusSource = "hook" | "osc" | "stream" | "e2e" | "hermes" | "os" | "guessed";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The strip's source label: how sure, then who said so. "exact · reported
 * by Claude Code", "signal · notification", "guessed", "guessed · process
 * activity". `agentName`: the reporting agent's display name, when known.
 */
export function stripSourceText(t: Translate, confidence: Confidence, source: StatusSource, agentName: string | null): string {
  if (confidence === "guessed") return source === "os" ? `${t("status.confidence.guessed")} · ${t("status.source.os")}` : t("status.confidence.guessed");
  const sure = t(`status.confidence.${confidence}`);
  if (source === "hook" || source === "stream") return `${sure} · ${agentName ? t("status.reportedBy", { agent: agentName }) : t("status.reportedByAgent")}`;
  return `${sure} · ${t(`status.source.${source}`)}`;
}

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
export function stripStatus(
  snapshot: SessionEventSnapshot,
  phase: string,
  inputTimes: readonly number[] = [],
): { status: AgentStatus; source: StatusSource; reporter?: string } {
  if (snapshot.version === 0) return { status: guessedStatus(phase), source: "guessed" };
  // Hermes's own observations (the terminal's heuristics, source "pty", and
  // the OS layer's process facts, source "os") never replace what the agent
  // reported: the strip shows the last status from anywhere else (or the
  // exit), and Hermes's best guess only while there is none, or once the
  // agent visibly resumed after a signal that the person answered
  // (deriveStatus, rule 6).
  let status: AgentStatus | null = null;
  let raw: string | undefined;
  const reported = (e: SessionEventSnapshot["events"][number]): AgentStatus | null =>
    e.type === "exit" ? { kind: "exited", confidence: "exact", detail: "" } : e.type === "status" && !isHeuristicSource(e.source) ? e.status : null;
  // The launch helper's "started" says nothing once the agent spoke itself
  // (deriveStatus, rule 8): it can land after the agent's first prompt.
  const firstAgentReport = snapshot.events.findIndex((e) => reported(e) !== null && isAgentReported(e.source));
  for (let i = snapshot.events.length - 1; i >= 0; i--) {
    const e = snapshot.events[i];
    const s = reported(e);
    if (!s) continue;
    if (firstAgentReport >= 0 && i > firstAgentReport && isHelperStartedEcho({ kind: s.kind, source: e.source ?? null })) continue;
    status = s;
    raw = e.source;
    // Hermes echoing what the agent just said (the launch helper's
    // "started" or "ended" right after the agent's own hook) leaves the
    // agent as the one who said it (deriveStatus, rule 8).
    if (!isAgentReported(raw)) {
      for (let j = i - 1; j >= 0; j--) {
        const prev = reported(snapshot.events[j]);
        if (!prev) continue;
        if (prev.kind === s.kind && prev.confidence === s.confidence && isAgentReported(snapshot.events[j].source)) raw = snapshot.events[j].source;
        break;
      }
    }
    if (resumedIndex(snapshot.events, i, inputTimes) >= 0) status = null;
    break;
  }
  if (!status || status.confidence === "guessed") {
    // Nobody reported anything sure: the best guess, the way the sidebar
    // folds it (a named guess, then the process facts, then the screen).
    const guess = foldStatus(snapshot.events, undefined, inputTimes);
    if (guess.source !== null && guess.confidence === "guessed") {
      const { kind, confidence, detail } = guess;
      return { status: { kind, confidence, detail }, source: guess.source === OS_SOURCE ? "os" : "guessed" };
    }
    return { status: status ?? guessedStatus(phase), source: "guessed" };
  }
  const source: StatusSource = raw?.startsWith("hook:") ? "hook" : raw === "osc" ? "osc" : raw?.startsWith("stream:") ? "stream" : raw === "e2e" ? "e2e" : raw === "hi" || raw === "hermes" || isHeuristicSource(raw) ? "hermes" : status.confidence === "signal" ? "osc" : "hook";
  const reporter = reporterOfSource(raw);
  return reporter && (source === "hook" || source === "stream") ? { status, source, reporter } : { status, source };
}

interface SessionStatusStripProps {
  sessionId: string;
  phase: string;
  /** The session's agent, named when the reporting event does not say which agent it was. */
  agentName?: string | null;
}

export function SessionStatusStrip({ sessionId, phase, agentName }: SessionStatusStripProps) {
  const { t } = useI18n();
  const snapshot = useSessionEvents(sessionId);
  const { status, source, reporter } = stripStatus(snapshot, phase, userInputTimes(sessionId));
  const confidence: Confidence = status.confidence;
  const guessed = confidence === "guessed";
  // Who reported it: the agent named by the event, else the session's agent.
  const sourceText = stripSourceText(t, confidence, source, getAgent(reporter)?.name ?? agentName ?? null);
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
      <Button
        variant="quiet"
        size="sm"
        className="session-status-strip-inbox"
        title={t("status.inboxHint", { shortcut: INBOX_SHORTCUT })}
        aria-label={t("status.inboxHint", { shortcut: INBOX_SHORTCUT })}
        onClick={openInbox}
      >
        <kbd className="h-row-shortcut">{INBOX_SHORTCUT}</kbd>
      </Button>
    </div>
  );
}
