import "../styles/components/SessionCreator.css";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project } from "../hooks/useSessionProjects";
import { CreateSessionOpts } from "../state/SessionContext";
import { getProjects, createProject, deleteProject } from "../api/projects";
import { gitListBranchesForRealm } from "../api/git";
import { LANG_COLORS } from "../utils/langColors";
import { SessionBranchSelector } from "./SessionBranchSelector";

const AI_PROVIDERS = [
  { id: "claude", label: "Claude", description: "Claude Code CLI", enabled: true },
  { id: "gemini", label: "Gemini", description: "Google Gemini CLI", enabled: true },
  { id: "aider", label: "Aider", description: "Aider AI pair programming", enabled: true },
  { id: "codex", label: "Codex", description: "OpenAI Codex CLI", enabled: true },
  { id: "copilot", label: "Copilot", description: "GitHub Copilot CLI", enabled: true },
] as const;

// Internal step identifiers (not displayed to user)
type Step = "projects" | "branch" | "ai" | "confirm";

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
}

export function SessionCreator({ onClose, onCreate }: SessionCreatorProps) {
  const [step, setStep] = useState<Step>("projects");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [highlightedProviderIndex, setHighlightedProviderIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const aiStepRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // Branch selection state
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [checkingGit, setCheckingGit] = useState(false);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [createNewBranch, setCreateNewBranch] = useState(false);

  // Determine whether to show the branch step
  const showBranchStep = isGitRepo && selectedProjectIds.length > 0;

  // Compute ordered steps for display
  const orderedSteps = useMemo<Step[]>(() => {
    const steps: Step[] = ["projects"];
    if (showBranchStep) steps.push("branch");
    steps.push("ai", "confirm");
    return steps;
  }, [showBranchStep]);

  const totalSteps = orderedSteps.length;
  const currentStepNumber = orderedSteps.indexOf(step) + 1;

  const goNext = useCallback(() => {
    const idx = orderedSteps.indexOf(step);
    if (idx < orderedSteps.length - 1) {
      setStep(orderedSteps[idx + 1]);
    }
  }, [step, orderedSteps]);

  const goBack = useCallback(() => {
    const idx = orderedSteps.indexOf(step);
    if (idx > 0) {
      setStep(orderedSteps[idx - 1]);
    }
  }, [step, orderedSteps]);

  useEffect(() => {
    getProjects()
      .then((r) => setAllProjects(r))
      .catch((err) => console.warn("[SessionCreator] Failed to load projects:", err));
  }, []);

  useEffect(() => {
    if (step === "projects") searchRef.current?.focus();
    if (step === "ai") {
      aiStepRef.current?.focus();
      const allItems = [...AI_PROVIDERS.filter((p) => p.enabled), { id: null }] as const;
      const currentIdx = allItems.findIndex((p) => p.id === aiProvider);
      setHighlightedProviderIndex(currentIdx >= 0 ? currentIdx : allItems.length - 1);
    }
    if (step === "confirm") labelRef.current?.focus();
  }, [step]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [query]);

  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll(".project-picker-item");
      items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  // Check if the first selected project is a git repo when selection changes
  useEffect(() => {
    if (selectedProjectIds.length === 0) {
      setIsGitRepo(false);
      setBranchName(null);
      setCreateNewBranch(false);
      return;
    }
    const realmId = selectedProjectIds[0];
    setCheckingGit(true);
    gitListBranchesForRealm(realmId)
      .then((branches) => {
        setIsGitRepo(branches.length > 0);
      })
      .catch(() => {
        setIsGitRepo(false);
      })
      .finally(() => {
        setCheckingGit(false);
      });
  }, [selectedProjectIds]);

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
        branchName: branchName || undefined,
        createNewBranch: createNewBranch || undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  const enabledProviders = useMemo(
    () => [...AI_PROVIDERS.filter((p) => p.enabled).map((p) => p.id), null] as const,
    []
  );

  const selectProviderAndAdvance = (idx: number) => {
    const id = enabledProviders[idx] ?? null;
    setAiProvider(id as string | null);
    setStep("confirm");
  };

  const handleBranchSelected = useCallback((name: string, isNew: boolean) => {
    setBranchName(name);
    setCreateNewBranch(isNew);
    setStep("ai");
  }, []);

  const handleBranchSkipped = useCallback(() => {
    setBranchName(null);
    setCreateNewBranch(false);
    setStep("ai");
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }

    if (step === "projects") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => {
          const next = prev - 1;
          if (next < 0) { searchRef.current?.focus(); return -1; }
          return next;
        });
      } else if (e.key === " " && highlightedIndex >= 0) {
        e.preventDefault();
        toggleProject(filtered[highlightedIndex].id);
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        goNext();
      }
    } else if (step === "ai") {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setHighlightedProviderIndex((prev) => (prev + 1) % enabledProviders.length);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setHighlightedProviderIndex((prev) => (prev - 1 + enabledProviders.length) % enabledProviders.length);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectProviderAndAdvance(highlightedProviderIndex);
      }
    }
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
          <span className="session-creator-step">Step {currentStepNumber} of {totalSteps}</span>
          <button className="close-btn settings-close" onClick={onClose} title="Close">x</button>
        </div>

        {/* Step indicator */}
        <div className="session-creator-steps">
          {orderedSteps.map((s, idx) => (
            <span
              key={s}
              className={`session-creator-step-dot ${currentStepNumber >= idx + 1 ? "active" : ""}`}
            />
          ))}
        </div>

        {/* Step 1: Select Projects */}
        {step === "projects" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Select Projects</div>
            <input
              ref={searchRef}
              className="command-palette-input"
              placeholder="Filter projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="session-creator-list" ref={listRef}>
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
              {filtered.map((project, idx) => (
                <div
                  key={project.id}
                  className={`project-picker-item ${selectedProjectIds.includes(project.id) ? "project-picker-item-attached" : ""} ${highlightedIndex === idx ? "session-creator-highlighted" : ""}`}
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
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
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
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd> navigate</span>
              <span><kbd>Space</kbd> toggle</span>
              <span><kbd>Enter</kbd> next</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={() => { setSelectedProjectIds([]); setStep("ai"); }}>
                Skip
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
                disabled={checkingGit}
              >
                {checkingGit ? "Checking..." : `Next (${selectedProjectIds.length} selected)`}
              </button>
            </div>
          </div>
        )}

        {/* Step 2 (conditional): Select Branch */}
        {step === "branch" && selectedProjectIds.length > 0 && (
          <SessionBranchSelector
            realmId={selectedProjectIds[0]}
            onBranchSelected={handleBranchSelected}
            onSkip={handleBranchSkipped}
          />
        )}

        {/* Step 3: Pick AI Engine */}
        {step === "ai" && (
          <div className="session-creator-body" ref={aiStepRef} tabIndex={-1} style={{ outline: "none" }}>
            <div className="session-creator-section-title">AI Engine</div>
            <div className="session-creator-provider-grid">
              {AI_PROVIDERS.map((p) => {
                const providerIdx = enabledProviders.indexOf(p.id);
                return (
                  <button
                    key={p.id}
                    className={`session-creator-provider-card ${aiProvider === p.id ? "selected" : ""} ${!p.enabled ? "disabled" : ""} ${p.enabled && highlightedProviderIndex === providerIdx ? "selected" : ""}`}
                    onClick={() => { if (p.enabled) { setAiProvider(p.id); setHighlightedProviderIndex(providerIdx); } }}
                    disabled={!p.enabled}
                  >
                    <span className="session-creator-provider-name">{p.label}</span>
                    <span className="session-creator-provider-desc">
                      {p.enabled ? p.description : "Coming soon"}
                    </span>
                  </button>
                );
              })}
              <button
                className={`session-creator-provider-card ${aiProvider === null ? "selected" : ""} ${highlightedProviderIndex === enabledProviders.length - 1 ? "selected" : ""}`}
                onClick={() => { setAiProvider(null); setHighlightedProviderIndex(enabledProviders.length - 1); }}
              >
                <span className="session-creator-provider-name">Shell Only</span>
                <span className="session-creator-provider-desc">No AI agent</span>
              </button>
            </div>
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd><kbd>&larr;&rarr;</kbd> navigate</span>
              <span><kbd>Enter</kbd> select</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                Back
              </button>
              <button className="session-creator-btn-primary" onClick={() => setStep("confirm")}>
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Confirm */}
        {step === "confirm" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Confirm</div>
            <div className="session-creator-summary">
              <div className="session-creator-summary-row">
                <span className="session-creator-summary-label">Projects:</span>
                <span className="session-creator-summary-value">
                  {selectedProjectNames.length > 0 ? selectedProjectNames.join(", ") : "None"}
                </span>
              </div>
              {branchName && (
                <div className="session-creator-summary-row">
                  <span className="session-creator-summary-label">Branch:</span>
                  <span className="session-creator-summary-value">
                    {branchName}{createNewBranch ? " (new)" : ""}
                  </span>
                </div>
              )}
              <div className="session-creator-summary-row">
                <span className="session-creator-summary-label">AI Engine:</span>
                <span className="session-creator-summary-value">
                  {aiProvider ? AI_PROVIDERS.find((p) => p.id === aiProvider)?.label ?? aiProvider : "Shell Only"}
                </span>
              </div>
            </div>
            <input
              ref={labelRef}
              className="command-palette-input"
              placeholder="Session label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) handleConfirm();
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="session-creator-hints">
              <span><kbd>Enter</kbd> create</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={() => setStep("ai")}>
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
