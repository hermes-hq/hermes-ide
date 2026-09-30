import "../styles/components/ScopeBar.css";
import { useState, useRef, useCallback } from "react";
import { useSessionProjects, Project } from "../hooks/useSessionProjects";
import { useSession } from "../state/SessionContext";
import { nudgeProjectContext, scanProject, detachSessionProject } from "../api/projects";
import { revealProcessInFinder } from "../api/processes";
import { ProjectPicker } from "./ProjectPicker";
import { useSessionGitSummary } from "../hooks/useSessionGitSummary";
import { useSessionModel } from "../agent/useSessionModel";
import { CUSTOM_AGENT_ID, agentDisplayName } from "../catalog/agentCatalog";
import { useContextMenu, menuItem, separator, subMenu } from "../hooks/useContextMenu";
import { homeDir } from "@tauri-apps/api/path";
import { Badge } from "./ui/Badge";
import { Button, IconButton } from "./ui/Button";
import { Chip } from "./ui/Chip";

const LANGUAGE_COLORS: Record<string, string> = {
  "JavaScript/TypeScript": "#f1e05a",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Python: "#3572a5",
  Go: "#00ADD8",
  Ruby: "#701516",
  Java: "#b07219",
  "Java/Kotlin": "#A97BFF",
  Kotlin: "#A97BFF",
  PHP: "#4F5D95",
  Dart: "#00B4AB",
  Swift: "#F05138",
  "C#": "#178600",
  "C++": "#f34b7d",
  C: "#555555",
};

interface ScopeBarProps {
  sessionId: string;
}

export function ScopeBar({ sessionId }: ScopeBarProps) {
  const { state, createSession } = useSession();
  const activeSession = state.sessions[sessionId];
  const model = useSessionModel(activeSession);
  const { projects, detach } = useSessionProjects(sessionId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { allBranches } = useSessionGitSummary(sessionId, true, activeSession?.working_directory);

  // Track which project was right-clicked for action handlers
  const contextProjectRef = useRef<{ project: Project; branch?: string } | null>(null);

  const handleContextAction = useCallback(async (actionId: string) => {
    const ctx = contextProjectRef.current;
    if (!ctx) return;
    const { project, branch } = ctx;

    switch (actionId) {
      case "project-pill.copy-path":
        navigator.clipboard.writeText(project.path);
        break;
      case "project-pill.copy-relative-path": {
        try {
          const home = await homeDir();
          const relative = project.path.startsWith(home)
            ? "~/" + project.path.slice(home.length)
            : project.path;
          navigator.clipboard.writeText(relative);
        } catch {
          navigator.clipboard.writeText(project.path);
        }
        break;
      }
      case "project-pill.copy-name":
        navigator.clipboard.writeText(project.name);
        break;
      case "project-pill.copy-branch":
        if (branch) navigator.clipboard.writeText(branch);
        break;
      case "project-pill.reveal":
        revealProcessInFinder(project.path).catch(console.warn);
        break;
      case "project-pill.open-terminal":
        createSession({ workingDirectory: project.path, projectIds: [project.id] }).catch(console.warn);
        break;
      case "project-pill.rescan":
        scanProject(project.id, "deep").catch(console.warn);
        break;
      case "project-pill.detach":
        detachSessionProject(sessionId, project.id)
          .then(() => nudgeProjectContext(sessionId).catch(console.warn))
          .catch(console.warn);
        break;
    }
  }, [sessionId, createSession]);

  const { showMenu } = useContextMenu(handleContextAction);

  const handlePillContextMenu = useCallback((e: React.MouseEvent, project: Project, branch?: string) => {
    contextProjectRef.current = { project, branch };

    const copyChildren = [
      menuItem("project-pill.copy-path", "Copy Path"),
      menuItem("project-pill.copy-relative-path", "Copy Relative Path"),
      menuItem("project-pill.copy-name", "Copy Project Name"),
      menuItem("project-pill.copy-branch", "Copy Branch Name", { enabled: !!branch }),
    ];

    const items = [
      subMenu("Copy", copyChildren),
      separator(),
      menuItem("project-pill.reveal", "Reveal in Finder"),
      menuItem("project-pill.open-terminal", "Open in Terminal"),
      separator(),
      menuItem("project-pill.rescan", "Rescan Project"),
      menuItem("project-pill.detach", "Detach from Session"),
    ];

    showMenu(e, items);
  }, [showMenu]);

  if (projects.length === 0 && !pickerOpen) {
    return (
      <div className="scope-bar scope-bar-empty">
        <Button variant="quiet" size="sm" className="scope-bar-add" onClick={() => setPickerOpen(true)}>
          + Add Project
        </Button>
      </div>
    );
  }

  const getLangColor = (project: Project) => {
    for (const lang of project.languages) {
      if (LANGUAGE_COLORS[lang]) return LANGUAGE_COLORS[lang];
    }
    return "#7b93db";
  };

  return (
    <>
      <div className="scope-bar">
        {projects.map((project) => {
          const branchInfo = allBranches.find(b => b.projectName === project.name);
          return (
            <Chip
              key={project.id}
              size="sm"
              className="scope-pill"
              title={project.path}
              onContextMenu={(e) => handlePillContextMenu(e, project, branchInfo?.branch)}
              removeLabel="Remove project"
              onRemove={() => detach(project.id).then(() => nudgeProjectContext(sessionId).catch(console.warn))}
            >
              <span
                className="scope-pill-dot"
                style={{ background: getLangColor(project) }}
              />
              <span className="scope-pill-name">{project.name}</span>
              {branchInfo && (
                <span className="scope-pill-branch" title={branchInfo.branch}>
                  <svg viewBox="0 0 16 16" fill="currentColor" width="9" height="9" aria-hidden="true">
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                  </svg>
                  {branchInfo.branch}
                </span>
              )}
              {project.scan_status === "pending" && (
                <span className="scope-pill-status" data-status={project.scan_status}>…</span>
              )}
            </Chip>
          );
        })}
        {(model ?? activeSession?.ai_provider) && (
          <Badge tone="info" className="scope-bar-provider" title={activeSession?.ai_provider ?? undefined}>
            {model ?? (activeSession?.ai_provider === CUSTOM_AGENT_ID ? agentDisplayName(activeSession) : activeSession?.ai_provider)}
          </Badge>
        )}
        <IconButton
          size="sm"
          className="scope-bar-add"
          label="Attach project"
          onClick={() => setPickerOpen(true)}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          }
        />
      </div>
      {pickerOpen && (
        <ProjectPicker
          sessionId={sessionId}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
