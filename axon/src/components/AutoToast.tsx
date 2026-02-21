import { useState, useEffect, useRef } from "react";

interface AutoToastProps {
  command: string;
  reason: "prediction" | "error_fix";
  delayMs: number;
  onCancel: () => void;
  onExecute: () => void;
}

export function AutoToast({ command, reason, delayMs, onCancel, onExecute }: AutoToastProps) {
  const [progress, setProgress] = useState(100);
  const startRef = useRef(Date.now());
  const executedRef = useRef(false);

  useEffect(() => {
    // Reset timer state when effect re-runs (delayMs or command changed)
    startRef.current = Date.now();
    executedRef.current = false;
    setProgress(100);

    const interval = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, 100 - (elapsed / delayMs) * 100);
      setProgress(remaining);
      if (remaining <= 0 && !executedRef.current) {
        executedRef.current = true;
        clearInterval(interval);
        onExecute();
      }
    }, 50);
    return () => clearInterval(interval);
  }, [delayMs, onExecute]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const label = reason === "prediction" ? "Auto-running" : "Auto-fix";

  return (
    <div className="auto-toast">
      <div className="auto-toast-header">
        <span className="auto-toast-label">{label}:</span>
        <span className="auto-toast-cmd mono">{command}</span>
      </div>
      <div className="auto-toast-progress-track">
        <div
          className="auto-toast-progress"
          style={{ width: `${progress}%` }}
        />
      </div>
      <button className="auto-toast-cancel" onClick={onCancel}>
        Cancel (Esc)
      </button>
    </div>
  );
}
