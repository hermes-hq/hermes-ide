import { useEffect } from "react";
import "../styles/components/QuitWithAgentsDialog.css";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "./ui";

/** A session the quit would interrupt: its id and the label people know it by. */
export interface WorkingSession {
  id: string;
  label: string;
}

interface QuitWithAgentsDialogProps {
  sessions: WorkingSession[];
  /** Quit and leave the agents running in the session host. */
  onKeep: () => void;
  /** Stop the agents, then quit. */
  onStop: () => void;
  onCancel: () => void;
}

/**
 * N20: quitting with a working agent asks "keep running or stop". Shown when
 * the window is closed or the app is told to quit while a hosted session has
 * an agent at work. Escape cancels; Enter keeps them running (the choice that
 * loses nothing).
 */
export function QuitWithAgentsDialog({ sessions, onKeep, onStop, onCancel }: QuitWithAgentsDialogProps) {
  const { t } = useI18n();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onKeep();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, onKeep]);

  return (
    <div className="quit-dialog-backdrop" onClick={onCancel} data-testid="quit-with-agents-dialog">
      <div className="quit-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-dialog-title" onClick={(e) => e.stopPropagation()}>
        <div className="quit-dialog-title" id="quit-dialog-title">{t("quit.keep.title")}</div>
        <div className="quit-dialog-body">{t("quit.keep.body", { count: sessions.length })}</div>
        <ul className="quit-dialog-sessions">
          {sessions.map((s) => (
            <li key={s.id} className="quit-dialog-session" data-session-id={s.id}>{s.label}</li>
          ))}
        </ul>
        <div className="quit-dialog-actions">
          <Button className="quit-dialog-btn" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" className="quit-dialog-btn-stop" onClick={onStop}>{t("quit.keep.stop")}</Button>
          <Button variant="primary" className="quit-dialog-btn-keep" onClick={onKeep} autoFocus>{t("quit.keep.keep")}</Button>
        </div>
      </div>
    </div>
  );
}
