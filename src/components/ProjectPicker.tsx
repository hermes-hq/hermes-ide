import "../styles/components/ProjectPicker.css";
import { Button, CloseButton, IconButton, Input } from "./ui";
import { translate } from "../i18n/registry";
import { CloseGlyph } from "./ui/icons";
import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionProjects } from "../hooks/useSessionProjects";
import { getProjectsOrdered, createProject, deleteProject, nudgeProjectContext } from "../api/projects";
import type { ProjectOrdered } from "../types/project";
import { LANG_COLORS } from "../utils/langColors";

interface ProjectPickerProps {
  sessionId: string;
  onClose: () => void;
}

export function ProjectPicker({ sessionId, onClose }: ProjectPickerProps) {
  const { projects: attachedProjects, attach, detach } = useSessionProjects(sessionId);
  const [allProjects, setAllProjects] = useState<ProjectOrdered[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const changed = useRef(false);

  useEffect(() => {
    getProjectsOrdered()
      .then((r) => setAllProjects(r))
      .catch((err) => console.warn("[ProjectPicker] Failed to load projects:", err));
    inputRef.current?.focus();
  }, []);

  const handleClose = () => {
    // Only nudge if the attached projects actually changed
    if (changed.current) {
      nudgeProjectContext(sessionId).catch((err) =>
        console.warn("[ProjectPicker] Failed to nudge project context:", err)
      );
    }
    onClose();
  };

  const attachedIds = useMemo(
    () => new Set(attachedProjects.map((r) => r.id)),
    [attachedProjects]
  );

  const filtered = useMemo(() => {
    if (!query) return allProjects;
    const q = query.toLowerCase();
    return allProjects.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.languages.some((l) => l.toLowerCase().includes(q))
    );
  }, [query, allProjects]);

  const toggleProject = async (project: ProjectOrdered) => {
    if (attachedIds.has(project.id)) {
      await detach(project.id);
    } else {
      await attach(project.id);
    }
    changed.current = true;
    // Refresh all projects in case of updates
    getProjectsOrdered()
      .then((r) => {
        setAllProjects(r);
        inputRef.current?.focus();
      })
      .catch((err) => console.warn("[ProjectPicker] Failed to refresh projects:", err));
  };

  const scanNewPath = async (path: string) => {
    const normalized = path.trim().replace(/\/+$/, "");
    if (!normalized) return;
    setScanning(true);
    try {
      // Check if a project with this path already exists
      const existing = allProjects.find(
        (r) => r.path.replace(/\/+$/, "") === normalized
      );
      if (existing) {
        // Move to top and auto-attach instead of creating a duplicate
        setAllProjects((prev) => [existing, ...prev.filter((r) => r.id !== existing.id)]);
        if (!attachedIds.has(existing.id)) {
          await attach(existing.id);
          changed.current = true;
        }
      } else {
        const project = await createProject(normalized, null);
        const ordered: ProjectOrdered = { ...project, session_count: 0, last_opened_at: null, path_exists: true };
        setAllProjects((prev) => [ordered, ...prev.filter((r) => r.id !== project.id)]);
        await attach(project.id);
        changed.current = true;
      }
      setScanPath("");
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setScanning(false);
      inputRef.current?.focus();
    }
  };

  const handleScanNew = () => scanNewPath(scanPath);

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

  const scanStatusLabel = (status: string) => {
    switch (status) {
      case "pending": return "...";
      case "surface": return "S";
      case "deep": return "D";
      case "full": return "F";
      default: return status;
    }
  };

  return (
    <div className="command-palette-overlay" onClick={handleClose}>
      <div
        className="project-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="project-picker-header">
          <span className="project-picker-title">Projects</span>
          <span className="project-picker-count">
            {attachedProjects.length} attached
          </span>
          <CloseButton className="project-picker-close" onClick={handleClose} label={translate("common.close")} />
        </div>

        <Input
          ref={inputRef}
          className="project-picker-filter"
          aria-label="Filter projects"
          placeholder="Filter projects..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") handleClose(); else e.stopPropagation(); }}
        />

        <div className="project-picker-body">
          {filtered.length === 0 && !query && (
            <div className="workspace-empty">
              No projects found. Scan a directory below to add one.
            </div>
          )}
          {filtered.length === 0 && query && (
            <div className="command-palette-empty">
              No projects matching "{query}"
            </div>
          )}
          {filtered.map((project) => (
            <div
              key={project.id}
              className={`project-picker-item ${attachedIds.has(project.id) ? "project-picker-item-attached" : ""} ${"path_exists" in project && !project.path_exists ? "project-picker-item-missing" : ""}`}
              onClick={() => {
                if ("path_exists" in project && !project.path_exists) return;
                toggleProject(project);
              }}
            >
              <span className="project-picker-check">
                {"path_exists" in project && !project.path_exists
                  ? "(!)"
                  : attachedIds.has(project.id) ? "[x]" : "[ ]"}
              </span>
              <div className="project-picker-info">
                <div className="project-picker-name">
                  {project.name}
                  <span className="project-picker-scan-badge" data-status={project.scan_status}>
                    {scanStatusLabel(project.scan_status)}
                  </span>
                </div>
                <div className="project-picker-path">{shortPath(project.path)}</div>
                {"path_exists" in project && !project.path_exists && (
                  <div className="project-picker-missing-label">Folder not found</div>
                )}
                <div className="project-picker-tags">
                  {project.languages.map((lang) => (
                    <span
                      key={lang}
                      className="workspace-lang-tag"
                      style={{
                        color: LANG_COLORS[lang] || "#7b93db",
                        borderColor: (LANG_COLORS[lang] || "#7b93db") + "66",
                      }}
                    >
                      {lang}
                    </span>
                  ))}
                  {project.frameworks.map((fw) => (
                    <span key={fw} className="workspace-fw-tag">{fw}</span>
                  ))}
                </div>
              </div>
              <IconButton
                size="sm"
                className="project-picker-delete"
                label={`Delete project ${project.name}`}
                title="Delete project"
                icon={<CloseGlyph />}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteProject(project.id).then(() => {
                    setAllProjects((prev) => prev.filter((r) => r.id !== project.id));
                  }).catch(console.error);
                }}
              />
            </div>
          ))}
        </div>

        <div className="project-picker-footer">
          <Input
            code
            className="project-picker-scan-input"
            aria-label="Folder to scan"
            placeholder="Path or browse..."
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleScanNew(); }}
          />
          <Button
            className="project-picker-browse"
            onClick={handleBrowse}
            disabled={scanning}
            title="Browse for folder"
          >
            {scanning ? "..." : "Browse"}
          </Button>
          <Button
            className="project-picker-scan"
            onClick={handleScanNew}
            disabled={scanning || !scanPath.trim()}
          >
            Scan
          </Button>
          <Button
            variant="primary"
            className="project-picker-done"
            onClick={handleClose}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
