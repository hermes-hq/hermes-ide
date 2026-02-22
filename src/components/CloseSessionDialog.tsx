import { useState, useEffect, useCallback } from "react";
import "../styles/components/CloseSessionDialog.css";

interface CloseSessionDialogProps {
  sessionId: string;
  onConfirm: (sessionId: string) => void;
  onCancel: () => void;
  onDontAskAgain: () => void;
}

export function CloseSessionDialog({ sessionId, onConfirm, onCancel, onDontAskAgain }: CloseSessionDialogProps) {
  const [dontAsk, setDontAsk] = useState(false);

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
        <div className="close-dialog-title">Close Session?</div>
        <div className="close-dialog-body">
          This will terminate the running terminal process.
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
            Close Session
          </button>
        </div>
      </div>
    </div>
  );
}
