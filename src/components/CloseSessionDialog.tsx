import { useState, useCallback, useRef } from "react";
import "../styles/components/CloseSessionDialog.css";
import type { SessionMode } from "../types/session";
import { useI18n } from "../i18n/I18nProvider";
import { useModalFocus } from "../hooks/useModalFocus";
import { Button, Checkbox } from "./ui";

interface CloseSessionDialogProps {
  sessionId: string;
  /** Mode of the session being closed.  Drives the title + body copy.
   *  Defaults to `terminal` if undefined for backwards compat. */
  sessionMode?: SessionMode;
  /** The session's name, shown in the title ("Close “Fix the build”?"). */
  label?: string | null;
  /** The agent running in it ("Claude Code"), when there is one. */
  agentName?: string | null;
  onConfirm: (sessionId: string) => void;
  onCancel: () => void;
  onDontAskAgain: () => void;
}

/**
 * "Close session?" — a modal alert dialog. The confirm button has focus;
 * Enter presses whichever button has focus (never Close while Cancel has
 * it), Escape cancels, Tab stays inside, and focus returns to the × that
 * opened it.
 */
export function CloseSessionDialog({ sessionId, sessionMode, label, agentName, onConfirm, onCancel, onDontAskAgain }: CloseSessionDialogProps) {
  const { t } = useI18n();
  const [dontAsk, setDontAsk] = useState(false);
  const mode: "agent" | "terminal" = sessionMode === "agent" ? "agent" : "terminal";
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useModalFocus(dialogRef, confirmRef, onCancel);

  const handleConfirm = useCallback(() => {
    if (dontAsk) {
      onDontAskAgain();
    }
    onConfirm(sessionId);
  }, [dontAsk, sessionId, onConfirm, onDontAskAgain]);

  const name = label?.trim();
  const title = name
    ? t("close.titleNamed", { label: name })
    : mode === "agent" ? t("close.agent.title") : t("close.terminal.title");
  const agent = agentName?.trim() || (mode === "agent" ? "Claude Code" : "");
  const body = agent ? t("close.bodyAgent", { agent }) : t("close.bodyProgram");

  return (
    <div className="close-dialog-backdrop" onClick={onCancel}>
      <div
        className="close-dialog"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`close-dialog-title-${sessionId}`}
        aria-describedby={`close-dialog-body-${sessionId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="close-dialog-title" id={`close-dialog-title-${sessionId}`}>{title}</div>
        <div className="close-dialog-body" id={`close-dialog-body-${sessionId}`}>
          {body}
        </div>
        <Checkbox className="close-dialog-checkbox" checked={dontAsk} onChange={setDontAsk} label={t("close.dontAsk")} />
        <div className="close-dialog-actions">
          <Button className="close-dialog-btn" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button ref={confirmRef} variant="danger-solid" className="close-dialog-btn-confirm" onClick={handleConfirm}>
            {mode === "agent" ? t("close.agent.confirm") : t("close.terminal.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
