import { useState } from "react";
import { useSessionRealms, Realm } from "../hooks/useSessionRealms";
import { useSession } from "../state/SessionContext";
import { RealmPicker } from "./RealmPicker";

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
  const { realms, detach } = useSessionRealms(sessionId);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (realms.length === 0 && !pickerOpen) {
    return (
      <div className="scope-bar scope-bar-empty">
        <button className="scope-bar-add" onClick={() => setPickerOpen(true)}>
          + Add Project
        </button>
        {pickerOpen && (
          <RealmPicker
            sessionId={sessionId}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  const getLangColor = (realm: Realm) => {
    for (const lang of realm.languages) {
      if (LANGUAGE_COLORS[lang]) return LANGUAGE_COLORS[lang];
    }
    return "#7b93db";
  };

  return (
    <>
      <div className="scope-bar">
        {realms.map((realm) => (
          <div key={realm.id} className="scope-pill" title={realm.path}>
            <span
              className="scope-pill-dot"
              style={{ background: getLangColor(realm) }}
            />
            <span className="scope-pill-name">{realm.name}</span>
            <span className="scope-pill-status" data-status={realm.scan_status}>
              {realm.scan_status === "pending" ? "..." : ""}
            </span>
            <button
              className="scope-pill-close"
              onClick={() => detach(realm.id)}
              title="Remove project"
            >
              x
            </button>
          </div>
        ))}
        {activeSession?.ai_provider && (
          <span className="scope-bar-provider">{activeSession.ai_provider}</span>
        )}
        <button className="scope-bar-add" onClick={() => setPickerOpen(true)}>
          +
        </button>
      </div>
      {pickerOpen && (
        <RealmPicker
          sessionId={sessionId}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
