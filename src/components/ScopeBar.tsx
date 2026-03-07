import "../styles/components/ScopeBar.css";
import { useState } from "react";
import { useSessionProjects, Project } from "../hooks/useSessionProjects";
import { useSession } from "../state/SessionContext";
import { ProjectPicker } from "./ProjectPicker";

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
  const { state } = useSession();
  const activeSession = state.sessions[sessionId];
  const { projects, detach } = useSessionProjects(sessionId);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (projects.length === 0 && !pickerOpen) {
    return (
      <div className="scope-bar scope-bar-empty">
        <button className="scope-bar-add" onClick={() => setPickerOpen(true)}>
          + Add Project
        </button>
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
        {projects.map((project) => (
          <div key={project.id} className="scope-pill" title={project.path}>
            <span
              className="scope-pill-dot"
              style={{ background: getLangColor(project) }}
            />
            <span className="scope-pill-name">{project.name}</span>
            <span className="scope-pill-status" data-status={project.scan_status}>
              {project.scan_status === "pending" ? "..." : ""}
            </span>
            <button
              className="scope-pill-close"
              onClick={() => detach(project.id)}
              title="Remove project"
              aria-label="Remove project"
            >
              &times;
            </button>
          </div>
        ))}
        {activeSession?.ai_provider && (
          <span className="scope-bar-provider">{activeSession.ai_provider}</span>
        )}
        <button className="scope-bar-add" onClick={() => setPickerOpen(true)} title="Attach project">
          +
        </button>
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
