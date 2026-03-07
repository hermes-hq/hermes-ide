import "../styles/components/WorkspacePanel.css";
import { useState, useEffect, useCallback } from "react";
import { Project } from "../hooks/useSessionProjects";
import { getProjects, createProject, deleteProject as apiDeleteProject, scanProject, scanDirectory as apiScanDirectory } from "../api/projects";
import { LANG_COLORS } from "../utils/langColors";

interface WorkspacePanelProps {
  onClose: () => void;
}

function projectShortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

const SCAN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  surface: "Surface",
  deep: "Deep",
  full: "Full",
};

export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadProjects = useCallback(() => {
    getProjects()
      .then((r) => setProjects(r))
      .catch(console.error);
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const scanDirectory = useCallback(async () => {
    if (!scanPath.trim()) return;
    setScanning(true);
    try {
      await apiScanDirectory(scanPath.trim(), 3);
      await createProject(scanPath.trim(), null).catch((err) => console.warn("[WorkspacePanel] Failed to create project:", err));
      loadProjects();
      setScanPath("");
    } catch (err) {
      console.warn("[WorkspacePanel] Scan failed:", err);
    }
    setScanning(false);
  }, [scanPath, loadProjects]);

  const scanHome = useCallback(async () => {
    setScanning(true);
    try {
      await apiScanDirectory("~", 2);
      loadProjects();
    } catch (err) {
      console.warn("[WorkspacePanel] Home scan failed:", err);
    }
    setScanning(false);
  }, [loadProjects]);

  const triggerScan = useCallback(async (projectId: string) => {
    await scanProject(projectId, "deep").catch(console.error);
    setTimeout(loadProjects, 3000);
  }, [loadProjects]);

  const deleteProjectById = useCallback(async (projectId: string) => {
    await apiDeleteProject(projectId).catch(console.error);
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="workspace-overlay" onClick={onClose}>
      <div className="workspace-panel" onClick={(e) => e.stopPropagation()}>
        <div className="workspace-header">
          <span className="workspace-title">Projects</span>
          <span className="workspace-count">{projects.length} projects</span>
          <button className="settings-close" onClick={onClose} title="Close">&times;</button>
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
          {projects.length === 0 && !scanning && (
            <div className="workspace-empty">
              <p>No projects detected yet.</p>
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
            {projects.map((project) => (
              <div key={project.id} className="workspace-project">
                <div className="workspace-project-header">
                  <span className="workspace-project-name">{project.name}</span>
                  <span className="project-scan-badge" data-status={project.scan_status}>
                    {SCAN_STATUS_LABELS[project.scan_status] || project.scan_status}
                  </span>
                  <div className="workspace-project-tags">
                    {project.languages.map((lang) => (
                      <span
                        key={lang}
                        className="workspace-lang-tag"
                        style={{ borderColor: LANG_COLORS[lang] || "#666", color: LANG_COLORS[lang] || "#999" }}
                      >
                        {lang}
                      </span>
                    ))}
                    {project.frameworks.map((fw) => (
                      <span key={fw} className="workspace-fw-tag">{fw}</span>
                    ))}
                  </div>
                </div>
                {project.architecture && (
                  <div className="project-arch-info">
                    <span className="project-arch-pattern">{project.architecture.pattern}</span>
                    {project.architecture.layers.length > 0 && (
                      <span className="project-arch-layers">
                        {project.architecture.layers.join(", ")}
                      </span>
                    )}
                  </div>
                )}
                <div className="workspace-project-path mono">{projectShortPath(project.path)}</div>
                <div className="project-actions">
                  <button
                    className="project-action-btn"
                    onClick={() => triggerScan(project.id)}
                    title="Trigger deep scan"
                  >
                    Scan
                  </button>
                  {confirmDeleteId === project.id ? (
                    <>
                      <button
                        className="project-action-btn project-action-delete"
                        onClick={() => { deleteProjectById(project.id); setConfirmDeleteId(null); }}
                      >
                        Confirm?
                      </button>
                      <button
                        className="project-action-btn"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="project-action-btn project-action-delete"
                      onClick={() => setConfirmDeleteId(project.id)}
                      title="Delete project"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

