import "../styles/components/SessionCreator.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project } from "../hooks/useSessionProjects";
import { CreateSessionOpts } from "../state/SessionContext";
import { getProjects, createProject, deleteProject } from "../api/projects";
import { LANG_COLORS } from "../utils/langColors";

const AI_PROVIDERS = [
  { id: "claude", label: "Claude", description: "Claude Code CLI", enabled: true },
  { id: "gemini", label: "Gemini", description: "Google Gemini CLI", enabled: true },
  { id: "aider", label: "Aider", description: "Aider AI pair programming", enabled: true },
  { id: "codex", label: "Codex", description: "OpenAI Codex CLI", enabled: true },
  { id: "copilot", label: "Copilot", description: "GitHub Copilot CLI", enabled: true },
] as const;

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
}

export function SessionCreator({ onClose, onCreate }: SessionCreatorProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getProjects()
      .then((r) => setAllProjects(r))
      .catch((err) => console.warn("[SessionCreator] Failed to load projects:", err));
  }, []);

  useEffect(() => {
    if (step === 1) searchRef.current?.focus();
  }, [step]);

  const filtered = useMemo(() => {
    if (!query) return allProjects;
    const q = query.toLowerCase();
    return allProjects.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.languages.some((l: string) => l.toLowerCase().includes(q))
    );
  }, [query, allProjects]);

  const selectedProjectNames = useMemo(() => {
    return selectedProjectIds
      .map((id) => allProjects.find((r) => r.id === id)?.name)
      .filter(Boolean) as string[];
  }, [selectedProjectIds, allProjects]);

  const toggleProject = (id: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const removeProject = async (id: string) => {
    try {
      await deleteProject(id);
      setAllProjects((prev) => prev.filter((r) => r.id !== id));
      setSelectedProjectIds((prev) => prev.filter((r) => r !== id));
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const scanNewPath = async (path: string) => {
    if (!path.trim()) return;
    setScanning(true);
    try {
      const project = await createProject(path.trim(), null);
      setAllProjects((prev) => [project, ...prev.filter((r) => r.id !== project.id)]);
      setSelectedProjectIds((prev) =>
        prev.includes(project.id) ? prev : [...prev, project.id]
      );
      setScanPath("");
    } catch (err) {
      console.error("Failed to create project:", err);
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
      const firstProjectPath = selectedProjectIds.length > 0
        ? allProjects.find((r) => r.id === selectedProjectIds[0])?.path
        : undefined;
      await onCreate({
        label: label || undefined,
        aiProvider: aiProvider || undefined,
        projectIds: selectedProjectIds.length > 0 ? selectedProjectIds : undefined,
        workingDirectory: firstProjectPath,
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
          <button className="close-btn settings-close" onClick={onClose}>x</button>
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
              {filtered.map((project) => (
                <div
                  key={project.id}
                  className={`project-picker-item ${selectedProjectIds.includes(project.id) ? "project-picker-item-attached" : ""}`}
                  onClick={() => toggleProject(project.id)}
                >
                  <span className="project-picker-check">
                    {selectedProjectIds.includes(project.id) ? "[x]" : "[ ]"}
                  </span>
                  <div className="project-picker-info">
                    <div className="project-picker-name">{project.name}</div>
                    <div className="project-picker-path">{shortPath(project.path)}</div>
                    {(project.languages.length > 0 || project.frameworks.length > 0) && (
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
                    )}
                  </div>
                  <button
                    className="session-creator-remove-btn"
                    onClick={(e) => { e.stopPropagation(); removeProject(project.id); }}
                    title="Remove project"
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
              <button className="session-creator-btn-secondary" onClick={() => { setSelectedProjectIds([]); setStep(2); }}>
                Skip
              </button>
              <button className="session-creator-btn-primary" onClick={() => setStep(2)}>
                Next ({selectedProjectIds.length} selected)
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
                  {selectedProjectNames.length > 0 ? selectedProjectNames.join(", ") : "None"}
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
