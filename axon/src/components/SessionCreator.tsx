import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Realm } from "../hooks/useSessionRealms";
import { CreateSessionOpts } from "../state/SessionContext";

const AI_PROVIDERS = [
  { id: "claude", label: "Claude", description: "Claude Code CLI", enabled: true },
  { id: "gemini", label: "Gemini", description: "Google Gemini CLI", enabled: true },
  { id: "aider", label: "Aider", description: "Aider AI pair programming", enabled: false },
  { id: "codex", label: "Codex", description: "OpenAI Codex CLI", enabled: false },
  { id: "copilot", label: "Copilot", description: "GitHub Copilot CLI", enabled: false },
] as const;

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
}

export function SessionCreator({ onClose, onCreate }: SessionCreatorProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedRealmIds, setSelectedRealmIds] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [allRealms, setAllRealms] = useState<Realm[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke("get_realms")
      .then((r) => setAllRealms(r as Realm[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === 1) searchRef.current?.focus();
  }, [step]);

  const filtered = useMemo(() => {
    if (!query) return allRealms;
    const q = query.toLowerCase();
    return allRealms.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.languages.some((l: string) => l.toLowerCase().includes(q))
    );
  }, [query, allRealms]);

  const selectedRealmNames = useMemo(() => {
    return selectedRealmIds
      .map((id) => allRealms.find((r) => r.id === id)?.name)
      .filter(Boolean) as string[];
  }, [selectedRealmIds, allRealms]);

  const toggleRealm = (id: string) => {
    setSelectedRealmIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const scanNewPath = async (path: string) => {
    if (!path.trim()) return;
    setScanning(true);
    try {
      const realm = (await invoke("create_realm", {
        path: path.trim(),
        name: null,
      })) as Realm;
      setAllRealms((prev) => [realm, ...prev.filter((r) => r.id !== realm.id)]);
      setSelectedRealmIds((prev) =>
        prev.includes(realm.id) ? prev : [...prev, realm.id]
      );
      setScanPath("");
    } catch (err) {
      console.error("Failed to create realm:", err);
    } finally {
      setScanning(false);
    }
  };

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await scanNewPath(selected);
    }
  };

  const shortPath = (p: string) => {
    const home = p.replace(/^\/Users\/[^/]+/, "~");
    return home.length > 50 ? "..." + home.slice(-47) : home;
  };

  const handleConfirm = async () => {
    setCreating(true);
    try {
      const firstRealmPath = selectedRealmIds.length > 0
        ? allRealms.find((r) => r.id === selectedRealmIds[0])?.path
        : undefined;
      await onCreate({
        label: label || undefined,
        aiProvider: aiProvider || undefined,
        realmIds: selectedRealmIds.length > 0 ? selectedRealmIds : undefined,
        workingDirectory: firstRealmPath,
      });
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="session-creator"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="session-creator-header">
          <span className="session-creator-title">New Session</span>
          <span className="session-creator-step">Step {step} of 3</span>
          <button className="settings-close" onClick={onClose}>x</button>
        </div>

        {/* Step indicator */}
        <div className="session-creator-steps">
          <span className={`session-creator-step-dot ${step >= 1 ? "active" : ""}`} />
          <span className={`session-creator-step-dot ${step >= 2 ? "active" : ""}`} />
          <span className={`session-creator-step-dot ${step >= 3 ? "active" : ""}`} />
        </div>

        {/* Step 1: Select Projects */}
        {step === 1 && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Select Projects</div>
            <input
              ref={searchRef}
              className="command-palette-input"
              placeholder="Filter projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="session-creator-list">
              {filtered.length === 0 && !query && (
                <div className="workspace-empty">
                  No projects found. Scan a directory below to add one.
                </div>
              )}
              {filtered.length === 0 && query && (
                <div className="command-palette-empty">
                  No projects matching &ldquo;{query}&rdquo;
                </div>
              )}
              {filtered.map((realm) => (
                <div
                  key={realm.id}
                  className={`realm-picker-item ${selectedRealmIds.includes(realm.id) ? "realm-picker-item-attached" : ""}`}
                  onClick={() => toggleRealm(realm.id)}
                >
                  <span className="realm-picker-check">
                    {selectedRealmIds.includes(realm.id) ? "[x]" : "[ ]"}
                  </span>
                  <div className="realm-picker-info">
                    <div className="realm-picker-name">{realm.name}</div>
                    <div className="realm-picker-path">{shortPath(realm.path)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="realm-picker-footer">
              <input
                className="workspace-scan-input"
                placeholder="Path or browse..."
                value={scanPath}
                onChange={(e) => setScanPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") scanNewPath(scanPath);
                }}
              />
              <button
                className="workspace-scan-btn"
                onClick={handleBrowse}
                disabled={scanning}
              >
                {scanning ? "..." : "Browse"}
              </button>
              <button
                className="workspace-scan-btn"
                onClick={() => scanNewPath(scanPath)}
                disabled={scanning || !scanPath.trim()}
              >
                Scan
              </button>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={() => { setSelectedRealmIds([]); setStep(2); }}>
                Skip
              </button>
              <button className="session-creator-btn-primary" onClick={() => setStep(2)}>
                Next ({selectedRealmIds.length} selected)
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Pick AI Engine */}
        {step === 2 && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">AI Engine</div>
            <div className="session-creator-provider-grid">
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`session-creator-provider-card ${aiProvider === p.id ? "selected" : ""} ${!p.enabled ? "disabled" : ""}`}
                  onClick={() => p.enabled && setAiProvider(p.id)}
                  disabled={!p.enabled}
                >
                  <span className="session-creator-provider-name">{p.label}</span>
                  <span className="session-creator-provider-desc">
                    {p.enabled ? p.description : "Coming soon"}
                  </span>
                </button>
              ))}
              <button
                className={`session-creator-provider-card ${aiProvider === null ? "selected" : ""}`}
                onClick={() => setAiProvider(null)}
              >
                <span className="session-creator-provider-name">Shell Only</span>
                <span className="session-creator-provider-desc">No AI agent</span>
              </button>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="session-creator-btn-primary" onClick={() => setStep(3)}>
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Confirm</div>
            <div className="session-creator-summary">
              <div className="session-creator-summary-row">
                <span className="session-creator-summary-label">Projects:</span>
                <span className="session-creator-summary-value">
                  {selectedRealmNames.length > 0 ? selectedRealmNames.join(", ") : "None"}
                </span>
              </div>
              <div className="session-creator-summary-row">
                <span className="session-creator-summary-label">AI Engine:</span>
                <span className="session-creator-summary-value">
                  {aiProvider ? AI_PROVIDERS.find((p) => p.id === aiProvider)?.label ?? aiProvider : "Shell Only"}
                </span>
              </div>
            </div>
            <input
              className="command-palette-input"
              placeholder="Session label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) handleConfirm();
              }}
            />
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={handleConfirm}
                disabled={creating}
              >
                {creating ? "Creating..." : "Create Session"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
