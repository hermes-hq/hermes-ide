import "../styles/components/ProjectPicker.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project, useSessionProjects } from "../hooks/useSessionProjects";
import { getProjects, createProject, deleteProject, nudgeProjectContext } from "../api/projects";
import { LANG_COLORS } from "../utils/langColors";

interface ProjectPickerProps {
  sessionId: string;
  onClose: () => void;
}

export function ProjectPicker({ sessionId, onClose }: ProjectPickerProps) {
  const { projects: attachedProjects, attach, detach } = useSessionProjects(sessionId);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const changed = useRef(false);

  useEffect(() => {
    getProjects()
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

  const toggleProject = async (project: Project) => {
    if (attachedIds.has(project.id)) {
      await detach(project.id);
    } else {
      await attach(project.id);
    }
    changed.current = true;
    // Refresh all projects in case of updates
    getProjects()
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
        setAllProjects((prev) => [project, ...prev.filter((r) => r.id !== project.id)]);
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
          <button className="close-btn settings-close" onClick={handleClose} aria-label="Close">
            &times;
          </button>
        </div>

        <input
          ref={inputRef}
          className="command-palette-input"
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
              className={`project-picker-item ${attachedIds.has(project.id) ? "project-picker-item-attached" : ""}`}
              onClick={() => toggleProject(project)}
            >
              <span className="project-picker-check">
                {attachedIds.has(project.id) ? "[x]" : "[ ]"}
              </span>
              <div className="project-picker-info">
                <div className="project-picker-name">
                  {project.name}
                  <span className="project-picker-scan-badge" data-status={project.scan_status}>
                    {scanStatusLabel(project.scan_status)}
                  </span>
                </div>
                <div className="project-picker-path">{shortPath(project.path)}</div>
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
              <button
                className="project-picker-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteProject(project.id).then(() => {
                    setAllProjects((prev) => prev.filter((r) => r.id !== project.id));
                  }).catch(console.error);
                }}
                title="Delete project"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="project-picker-footer">
          <input
            className="workspace-scan-input"
            placeholder="Path or browse..."
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleScanNew(); }}
          />
          <button
            className="workspace-scan-btn"
            onClick={handleBrowse}
            disabled={scanning}
            title="Browse for folder"
          >
            {scanning ? "..." : "Browse"}
          </button>
          <button
            className="workspace-scan-btn"
            onClick={handleScanNew}
            disabled={scanning || !scanPath.trim()}
          >
            Scan
          </button>
          <button
            className="project-picker-done"
            onClick={handleClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
