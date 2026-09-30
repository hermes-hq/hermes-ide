import "../styles/components/WorkspacePanel.css";
import { Button, CloseButton, Input } from "./ui";
import { useState, useEffect, useCallback } from "react";
import { Project } from "../hooks/useSessionProjects";
import { getProjects, createProject, deleteProject as apiDeleteProject, scanProject, scanDirectory as apiScanDirectory } from "../api/projects";
import { LANG_COLORS } from "../utils/langColors";
import { useI18n } from "../i18n/I18nProvider";

interface WorkspacePanelProps {
  onClose: () => void;
}

function projectShortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

const SCAN_STATUS_KEYS: Record<string, string> = {
  pending: "workspace.scan.pending",
  surface: "workspace.scan.surface",
  deep: "workspace.scan.deep",
  full: "workspace.scan.full",
};

export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
  const { t } = useI18n();
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
          <span className="workspace-title">{t("workspace.projects")}</span>
          <span className="workspace-count">{t("workspace.projectCount", { count: projects.length })}</span>
          <CloseButton className="workspace-close" onClick={onClose} label={t("common.close")} />
        </div>

        <div className="workspace-scan-row">
          <Input
            code
            className="workspace-panel-scan-input"
            aria-label={t("workspace.pathPlaceholder")}
            placeholder={t("workspace.pathPlaceholder")}
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") scanDirectory(); }}
          />
          <Button variant="primary" className="workspace-panel-scan" onClick={scanDirectory} disabled={scanning}>
            {scanning ? "..." : t("common.scan")}
          </Button>
        </div>

        <div className="workspace-body">
          {projects.length === 0 && !scanning && (
            <div className="workspace-empty">
              <p>{t("workspace.noProjects")}</p>
              <Button className="workspace-scan-home-btn" onClick={scanHome}>
                {t("workspace.scanHome")}
              </Button>
            </div>
          )}
          {scanning && (
            <div className="workspace-scanning">
              <div className="loading-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
              <span>{t("workspace.scanning")}</span>
            </div>
          )}
          <div className="workspace-project-list">
            {projects.map((project) => (
              <div key={project.id} className="workspace-project">
                <div className="workspace-project-header">
                  <span className="workspace-project-name">{project.name}</span>
                  <span className="project-scan-badge" data-status={project.scan_status}>
                    {SCAN_STATUS_KEYS[project.scan_status] ? t(SCAN_STATUS_KEYS[project.scan_status]) : project.scan_status}
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
                  <Button
                    size="sm"
                    className="project-action-scan"
                    onClick={() => triggerScan(project.id)}
                    title={t("workspace.triggerDeepScan")}
                  >
                    {t("common.scan")}
                  </Button>
                  {confirmDeleteId === project.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        className="project-action-delete"
                        onClick={() => { deleteProjectById(project.id); setConfirmDeleteId(null); }}
                      >
                        {t("common.confirmQuestion")}
                      </Button>
                      <Button
                        size="sm"
                        className="project-action-cancel"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      className="project-action-delete"
                      onClick={() => setConfirmDeleteId(project.id)}
                      title={t("workspace.deleteProject")}
                    >
                      {t("common.delete")}
                    </Button>
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
