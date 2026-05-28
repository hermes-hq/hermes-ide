import { useState, useEffect, useCallback } from "react";
import "../styles/components/CloseSessionDialog.css";
import type { SessionMode } from "../types/session";
import { useI18n } from "../i18n/I18nProvider";

interface CloseSessionDialogProps {
  sessionId: string;
  /** Mode of the session being closed.  Drives the title + body copy.
   *  Defaults to `terminal` if undefined for backwards compat. */
  sessionMode?: SessionMode;
  onConfirm: (sessionId: string) => void;
  onCancel: () => void;
  onDontAskAgain: () => void;
}

/** Returns the body-text shown in the dialog, mode-conditional.
 *  Exported as a tiny pure function so unit tests can cover both branches
 *  without rendering the full React component. */
export function closeSessionDialogCopy(mode: "agent" | "terminal"): string {
  return mode === "agent"
    ? "This will end the conversation with Claude."
    : "This will terminate the running terminal session.";
}

/** Returns the dialog title, mode-conditional. */
export function closeSessionDialogTitle(mode: "agent" | "terminal"): string {
  return mode === "agent" ? "End conversation?" : "Close session?";
}

/** Returns the confirm-button label, mode-conditional. */
export function closeSessionDialogConfirmLabel(mode: "agent" | "terminal"): string {
  return mode === "agent" ? "End conversation" : "Close session";
}

export function CloseSessionDialog({ sessionId, sessionMode, onConfirm, onCancel, onDontAskAgain }: CloseSessionDialogProps) {
  const { t } = useI18n();
  const [dontAsk, setDontAsk] = useState(false);
  const mode: "agent" | "terminal" = sessionMode === "agent" ? "agent" : "terminal";

  const handleConfirm = useCallback(() => {
    if (dontAsk) {
      onDontAskAgain();
    }
    onConfirm(sessionId);
  }, [dontAsk, sessionId, onConfirm, onDontAskAgain]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, handleConfirm]);

  return (
    <div className="close-dialog-backdrop" onClick={onCancel}>
      <div className="close-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="close-dialog-title">{mode === "agent" ? t("close.agent.title") : t("close.terminal.title")}</div>
        <div className="close-dialog-body">
          {mode === "agent" ? t("close.agent.body") : t("close.terminal.body")}
        </div>
        <label className="close-dialog-checkbox">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          {t("close.dontAsk")}
        </label>
        <div className="close-dialog-actions">
          <button className="close-dialog-btn" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="close-dialog-btn close-dialog-btn-confirm" onClick={handleConfirm}>
            {mode === "agent" ? t("close.agent.confirm") : t("close.terminal.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
