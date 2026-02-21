import { useState, useEffect, useCallback } from "react";
import { Realm } from "../hooks/useSessionRealms";
import { getRealms, createRealm, deleteRealm as apiDeleteRealm, scanRealm, scanDirectory as apiScanDirectory } from "../api/realms";

interface WorkspacePanelProps {
  onClose: () => void;
}

const LANG_COLORS: Record<string, string> = {
  "JavaScript": "#f7df1e",
  "TypeScript": "#3178c6",
  "Python": "#3776ab",
  "Rust": "#dea584",
  "Go": "#00add8",
  "Ruby": "#cc342d",
  "Java": "#b07219",
  "Kotlin": "#a97bff",
  "Swift": "#f05138",
  "C#": "#178600",
  "C++": "#f34b7d",
  "C": "#555555",
  "PHP": "#4f5d95",
  "Dart": "#00b4ab",
  "JavaScript/TypeScript": "#3178c6",
  "Java/Kotlin": "#b07219",
};

function realmShortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

const SCAN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  surface: "Surface",
  deep: "Deep",
  full: "Full",
};

export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
  const [realms, setRealms] = useState<Realm[]>([]);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);

  const loadRealms = useCallback(() => {
    getRealms()
      .then((r) => setRealms(r))
      .catch(console.error);
  }, []);

  useEffect(() => { loadRealms(); }, [loadRealms]);

  const scanDirectory = useCallback(async () => {
    if (!scanPath.trim()) return;
    setScanning(true);
    try {
      // First scan for projects (legacy), which also populates the projects table
      await apiScanDirectory(scanPath.trim(), 3);
      // Then create a realm for the scanned path itself
      await createRealm(scanPath.trim(), null).catch((err) => console.warn("[WorkspacePanel] Failed to create realm:", err));
      // Reload realms
      loadRealms();
      setScanPath("");
    } catch (err) {
      console.warn("[WorkspacePanel] Scan failed:", err);
    }
    setScanning(false);
  }, [scanPath, loadRealms]);

  const scanHome = useCallback(async () => {
    setScanning(true);
    try {
      await apiScanDirectory("~", 2);
      loadRealms();
    } catch (err) {
      console.warn("[WorkspacePanel] Home scan failed:", err);
    }
    setScanning(false);
  }, [loadRealms]);

  const triggerScan = useCallback(async (realmId: string) => {
    await scanRealm(realmId, "deep").catch(console.error);
    // Will be updated via realm-updated event, but also refetch
    setTimeout(loadRealms, 3000);
  }, [loadRealms]);

  const deleteRealmById = useCallback(async (realmId: string) => {
    await apiDeleteRealm(realmId).catch(console.error);
    loadRealms();
  }, [loadRealms]);

  return (
    <div className="workspace-overlay" onClick={onClose}>
      <div className="workspace-panel" onClick={(e) => e.stopPropagation()}>
        <div className="workspace-header">
          <span className="workspace-title">Projects</span>
          <span className="workspace-count">{realms.length} projects</span>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="workspace-scan-row">
          <input
            className="workspace-scan-input"
            placeholder="Path to scan (e.g. ~/Projects)"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") scanDirectory(); }}
          />
          <button className="workspace-scan-btn" onClick={scanDirectory} disabled={scanning}>
            {scanning ? "..." : "Scan"}
          </button>
        </div>

        <div className="workspace-body">
          {realms.length === 0 && !scanning && (
            <div className="workspace-empty">
              <p>No realms detected yet.</p>
              <button className="workspace-scan-home-btn" onClick={scanHome}>
                Scan home directory
              </button>
            </div>
          )}
          {scanning && (
            <div className="workspace-scanning">
              <div className="loading-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
              <span>Scanning...</span>
            </div>
          )}
          <div className="workspace-project-list">
            {realms.map((realm) => (
              <div key={realm.id} className="workspace-project">
                <div className="workspace-project-header">
                  <span className="workspace-project-name">{realm.name}</span>
                  <span className="realm-scan-badge" data-status={realm.scan_status}>
                    {SCAN_STATUS_LABELS[realm.scan_status] || realm.scan_status}
                  </span>
                  <div className="workspace-project-tags">
                    {realm.languages.map((lang) => (
                      <span
                        key={lang}
                        className="workspace-lang-tag"
                        style={{ borderColor: LANG_COLORS[lang] || "#666", color: LANG_COLORS[lang] || "#999" }}
                      >
                        {lang}
                      </span>
                    ))}
                    {realm.frameworks.map((fw) => (
                      <span key={fw} className="workspace-fw-tag">{fw}</span>
                    ))}
                  </div>
                </div>
                {realm.architecture && (
                  <div className="realm-arch-info">
                    <span className="realm-arch-pattern">{realm.architecture.pattern}</span>
                    {realm.architecture.layers.length > 0 && (
                      <span className="realm-arch-layers">
                        {realm.architecture.layers.join(", ")}
                      </span>
                    )}
                  </div>
                )}
                <div className="workspace-project-path mono">{realmShortPath(realm.path)}</div>
                <div className="realm-actions">
                  <button
                    className="realm-action-btn"
                    onClick={() => triggerScan(realm.id)}
                    title="Trigger deep scan"
                  >
                    Scan
                  </button>
                  <button
                    className="realm-action-btn realm-action-delete"
                    onClick={() => deleteRealmById(realm.id)}
                    title="Delete realm"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

