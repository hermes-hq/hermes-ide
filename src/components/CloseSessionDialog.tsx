import { useState, useEffect, useCallback } from "react";
import "../styles/components/CloseSessionDialog.css";
import type { SessionMode } from "../types/session";

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
        <div className="close-dialog-title">{closeSessionDialogTitle(mode)}</div>
        <div className="close-dialog-body">
          {closeSessionDialogCopy(mode)}
        </div>
        <label className="close-dialog-checkbox">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          Don't ask again
        </label>
        <div className="close-dialog-actions">
          <button className="close-dialog-btn" onClick={onCancel}>Cancel</button>
          <button className="close-dialog-btn close-dialog-btn-confirm" onClick={handleConfirm}>
            {closeSessionDialogConfirmLabel(mode)}
          </button>
        </div>
      </div>
    </div>
  );
}
