import "../styles/components/PortForwardsPanel.css";
import { useState, useEffect, useCallback } from "react";
import type { PortForward } from "../types/session";
import { sshAddPortForward, sshRemovePortForward, sshListPortForwards } from "../api/sessions";

interface PortForwardsPanelProps {
  sessionId: string;
  onClose: () => void;
}

export function PortForwardsPanel({ sessionId, onClose }: PortForwardsPanelProps) {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(() => {
    sshListPortForwards(sessionId)
      .then(setForwards)
      .catch((err) => console.warn("[PortForwards] list failed:", err));
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    const lp = parseInt(localPort);
    const rp = parseInt(remotePort);
    if (!lp || !rp || !remoteHost.trim()) {
      setError("All fields are required");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await sshAddPortForward(sessionId, lp, remoteHost.trim(), rp, label.trim() || undefined);
      setLocalPort("");
      setRemotePort("");
      setLabel("");
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (port: number) => {
    try {
      await sshRemovePortForward(sessionId, port);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="port-forwards-panel">
      <div className="port-forwards-header">
        <span className="port-forwards-title">Port Forwards</span>
        <button className="port-forwards-close" onClick={onClose}>&times;</button>
      </div>

      {forwards.length > 0 && (
        <div className="port-forwards-list">
          {forwards.map((f) => (
            <div key={f.local_port} className="port-forward-item">
              <span className="port-forward-spec">
                {f.label && <span className="port-forward-label">{f.label}</span>}
                <code>:{f.local_port} &rarr; {f.remote_host}:{f.remote_port}</code>
              </span>
              <button
                className="port-forward-remove"
                onClick={() => handleRemove(f.local_port)}
                title="Remove forward"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {forwards.length === 0 && (
        <div className="port-forwards-empty">No active port forwards</div>
      )}

      <div className="port-forwards-form">
        <div className="port-forwards-form-row">
          <input
            className="port-forwards-input port-forwards-input-port"
            placeholder="Local port"
            type="number"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); e.stopPropagation(); }}
          />
          <span className="port-forwards-arrow">&rarr;</span>
          <input
            className="port-forwards-input port-forwards-input-host"
            placeholder="Remote host"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); e.stopPropagation(); }}
          />
          <input
            className="port-forwards-input port-forwards-input-port"
            placeholder="Remote port"
            type="number"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); e.stopPropagation(); }}
          />
        </div>
        <div className="port-forwards-form-row">
          <input
            className="port-forwards-input port-forwards-input-label"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); e.stopPropagation(); }}
          />
          <button
            className="port-forwards-add-btn"
            onClick={handleAdd}
            disabled={adding}
          >
            {adding ? "Adding..." : "Add"}
          </button>
        </div>
      </div>

      {error && <div className="port-forwards-error">{error}</div>}
    </div>
  );
}
