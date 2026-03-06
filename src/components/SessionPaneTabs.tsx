import "../styles/components/SessionPaneTabs.css";

export type SessionPaneTab = "terminal" | "git";

interface SessionPaneTabsProps {
  activeTab: SessionPaneTab;
  onTabChange: (tab: SessionPaneTab) => void;
  sessionId: string;
  /** When true, the Git tab is shown. When false, only Terminal is shown. */
  hasGitRepo?: boolean;
  /** Optional: show git change count badge on the git tab */
  gitChangeCount?: number;
  /** Optional: show branch name on the git tab */
  gitBranch?: string | null;
}

const TerminalIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
    <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z" />
  </svg>
);

const GitIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
  </svg>
);

export function SessionPaneTabs({
  activeTab,
  onTabChange,
  hasGitRepo = false,
  gitChangeCount,
  gitBranch,
}: SessionPaneTabsProps) {
  // If there's no git repo, don't show the tab bar at all — just terminal
  if (!hasGitRepo) return null;

  return (
    <div className="session-pane-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={activeTab === "terminal"}
        className={`session-pane-tab${activeTab === "terminal" ? " session-pane-tab-active" : ""}`}
        onClick={() => onTabChange("terminal")}
      >
        <TerminalIcon />
        <span>Terminal</span>
      </button>
      <button
        role="tab"
        aria-selected={activeTab === "git"}
        className={`session-pane-tab${activeTab === "git" ? " session-pane-tab-active" : ""}`}
        onClick={() => onTabChange("git")}
      >
        <GitIcon />
        <span>Git</span>
        {gitBranch && (
          <span className="session-pane-tab-branch">{gitBranch}</span>
        )}
        {typeof gitChangeCount === "number" && gitChangeCount > 0 && (
          <span className="session-pane-tab-badge">{gitChangeCount}</span>
        )}
      </button>
    </div>
  );
}
