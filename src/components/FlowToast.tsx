import "../styles/components/FlowToast.css";
import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

interface FlowToastProps {
  sessionId: string;
}

interface ToastMessage {
  id: number;
  text: string;
}

let toastCounter = 0;

export function FlowToast({ sessionId }: FlowToastProps) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((text: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ fingerprint: string; occurrence_count: number }>(`error-matched-${sessionId}`, (event) => {
      addToast(`Error detected (seen ${event.payload.occurrence_count}x)`);
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [sessionId, addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="flow-toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="flow-toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
