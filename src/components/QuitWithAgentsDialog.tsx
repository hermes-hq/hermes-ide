import { useEffect } from "react";
import "../styles/components/QuitWithAgentsDialog.css";
import { useI18n } from "../i18n/I18nProvider";
import { getSessionStatus } from "../agent/status/attentionStore";
import { statusLabel } from "../agent/status/presentation";
import type { AgentStatusKind } from "../agent/contract/status";
import { Button } from "./ui";

/** A session the quit would interrupt: its id and the label people know it by. */
export interface WorkingSession {
  id: string;
  label: string;
  /** The session lives in the session host, so it can keep running after
   *  Hermes quits. Unset: hosted (the dialog asked only about those). */
  hosted?: boolean;
  /** An agent works in it (else a program: a build, a server, a REPL).
   *  Unset: an agent. */
  agent?: boolean;
}

interface QuitWithAgentsDialogProps {
  sessions: WorkingSession[];
  /** Quit and leave the hosted sessions running in the session host. */
  onKeep: () => void;
  /** Stop them, then quit. */
  onStop: () => void;
  onCancel: () => void;
  /** Tasks waiting in the queue (LEAD-02): they are kept and start the next time Hermes opens. */
  queuedCount?: number;
}

/** What a row says a session is doing, as the title and body count it. */
export type QuitRowState = "working" | "waiting" | "open" | "program";

/** The kinds that mean the agent is waiting for the person. */
const WAITING_KINDS: ReadonlySet<AgentStatusKind> = new Set<AgentStatusKind>(["needs_approval", "needs_answer", "plan_ready", "startup_prompt", "gate"]);

/** What a row of the dialog shows: a program, or the agent's status in three words. */
export function quitRowState(session: WorkingSession, kind: AgentStatusKind): QuitRowState {
  if (session.agent === false) return "program";
  if (kind === "working" || kind === "starting") return "working";
  return WAITING_KINDS.has(kind) ? "waiting" : "open";
}

/**
 * Title, body and row words for what is running (CHAOS-19, XP-05). The
 * title and the body say what the rows show: how many agents work, how
 * many wait for the person, how many are open but not working, and how
 * many programs run. `kindOf`: each session's status.
 */
export function quitDialogCopy(
  sessions: readonly WorkingSession[],
  kindOf: (sessionId: string) => AgentStatusKind = (id) => getSessionStatus(id).kind,
): {
  titleKey: string;
  /** The body's sentences, in order: [key, count]. */
  body: [string, number][];
  canKeep: boolean;
} {
  const counts: Record<QuitRowState, number> = { working: 0, waiting: 0, open: 0, program: 0 };
  for (const s of sessions) counts[quitRowState(s, s.agent === false ? "idle" : kindOf(s.id))]++;
  const agents = counts.working + counts.waiting + counts.open;
  const programs = counts.program;
  const canKeep = sessions.some((s) => s.hosted !== false);
  const titleKey =
    programs === 0
      ? counts.working === agents
        ? "quit.keep.title"
        : counts.waiting === agents
          ? "quit.keep.titleWaiting"
          : "quit.keep.titleOpen"
      : agents === 0
        ? programs === 1
          ? "quit.keep.titleProgramOne"
          : "quit.keep.titleProgramMany"
        : "quit.keep.titleMixed";
  const body: [string, number][] = [];
  for (const state of ["working", "waiting", "open", "program"] as const) {
    const n = counts[state];
    if (n > 0) body.push([`quit.summary.${state}${n === 1 ? "One" : "Many"}`, n]);
  }
  const one = sessions.length === 1;
  body.push([canKeep ? (one ? "quit.keep.actionOne" : "quit.keep.actionMany") : one ? "quit.stop.actionOne" : "quit.stop.actionMany", sessions.length]);
  return { titleKey, body, canKeep };
}

/**
 * N20: quitting with something still working asks first. With the session
 * host, hosted sessions can keep running while Hermes is closed ("Keep
 * running", the choice that loses nothing, is Enter). Without it (Windows,
 * or the host off), quitting stops them: the dialog says so and offers only
 * "Stop and quit" or Cancel (Enter cancels). Each row says whether it is an
 * agent (with its status) or a program, and, next to sessions that can keep
 * running, which ones stop anyway.
 */
export function QuitWithAgentsDialog({ sessions, onKeep, onStop, onCancel, queuedCount = 0 }: QuitWithAgentsDialogProps) {
  const { t } = useI18n();
  const { titleKey, body, canKeep } = quitDialogCopy(sessions);
  // Only queued tasks: nothing to keep running or stop, the quit only says what happens to them.
  const queueOnly = sessions.length === 0;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter takes the choice that loses nothing: keep running, or with
        // only queued tasks (kept for the next start) quit.
        if (canKeep || queueOnly) onKeep();
        else onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, onKeep, canKeep, queueOnly]);

  const rowState = (s: WorkingSession): string => {
    if (s.agent === false) return t("quit.row.program");
    const status = getSessionStatus(s.id);
    return statusLabel(status, t).word;
  };

  return (
    <div className="quit-dialog-backdrop" onClick={onCancel} data-testid="quit-with-agents-dialog" data-can-keep={canKeep ? "true" : "false"}>
      <div className="quit-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-dialog-title" onClick={(e) => e.stopPropagation()}>
        <div className="quit-dialog-title" id="quit-dialog-title">{queueOnly ? t("quit.queue.title") : t(titleKey)}</div>
        {!queueOnly && <div className="quit-dialog-body">{body.map(([key, count]) => t(key, { count })).join(" ")}</div>}
        {!queueOnly && (
          <ul className="quit-dialog-sessions">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="quit-dialog-session"
                data-session-id={s.id}
                data-kind={s.agent === false ? "program" : "agent"}
                data-hosted={s.hosted === false ? "false" : "true"}
              >
                <span className="quit-dialog-session-label">{s.label}</span>
                <span className="quit-dialog-session-state">
                  {rowState(s)}
                  {canKeep && s.hosted === false ? ` · ${t("quit.row.stops")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {queuedCount > 0 && (
          <div className="quit-dialog-body quit-dialog-queued" data-count={queuedCount}>
            {queuedCount === 1 ? t("quit.queue.bodyOne") : t("quit.queue.body", { count: queuedCount })}
          </div>
        )}
        <div className="quit-dialog-actions">
          <Button className="quit-dialog-btn" onClick={onCancel} autoFocus={!queueOnly && !canKeep}>{t("common.cancel")}</Button>
          {!queueOnly && <Button variant="danger" className="quit-dialog-btn-stop" onClick={onStop}>{t("quit.keep.stop")}</Button>}
          {queueOnly ? (
            <Button variant="primary" className="quit-dialog-btn-quit" onClick={onKeep} autoFocus>{t("quit.queue.quit")}</Button>
          ) : canKeep && (
            <Button variant="primary" className="quit-dialog-btn-keep" onClick={onKeep} autoFocus>{t("quit.keep.keep")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
