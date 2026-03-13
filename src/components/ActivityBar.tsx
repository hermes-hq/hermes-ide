import type { ReactNode } from "react";
import "../styles/components/ActivityBar.css";

export interface ActivityBarTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

interface ActivityBarProps {
  side: "left" | "right";
  tabs: ActivityBarTab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  topAction?: { icon: ReactNode; label: string; onClick: () => void };
  bottomAction?: { icon: ReactNode; label: string; onClick: () => void };
}

export function ActivityBar({ side, tabs, activeTabId, onTabClick, topAction, bottomAction }: ActivityBarProps) {
  return (
    <div className={`activity-bar activity-bar-${side}`}>
      {topAction && (
        <>
          <button
            className="activity-bar-action"
            onClick={topAction.onClick}
            title={topAction.label}
          >
            {topAction.icon}
          </button>
          <div className="activity-bar-separator" />
        </>
      )}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`activity-bar-tab${activeTabId === tab.id ? " activity-bar-tab-active" : ""}`}
          onClick={() => onTabClick(tab.id)}
          title={tab.label}
        >
          {tab.icon}
          {tab.badge != null && tab.badge > 0 && (
            <span className="activity-bar-badge">{tab.badge}</span>
          )}
        </button>
      ))}
      {bottomAction && (
        <>
          <div className="activity-bar-bottom-spacer" />
          <button
            className="activity-bar-action"
            onClick={bottomAction.onClick}
            title={bottomAction.label}
          >
            {bottomAction.icon}
          </button>
        </>
      )}
    </div>
  );
}

/* ─── Inline SVG Icons ────────────────────────────────────── */

export const SessionsIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="14" height="10" rx="2" />
    <rect x="4" y="3" width="10" height="6" rx="1.5" opacity="0.5" />
  </svg>
);

export const ContextIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="7" />
    <line x1="9" y1="5" x2="9" y2="9.5" />
    <circle cx="9" cy="12.5" r="0.75" fill="currentColor" stroke="none" />
  </svg>
);

export const ProcessesIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="6" height="6" rx="1" />
    <rect x="10" y="2" width="6" height="6" rx="1" />
    <rect x="2" y="10" width="6" height="6" rx="1" />
    <rect x="10" y="10" width="6" height="6" rx="1" />
  </svg>
);

export const GitIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="5" r="2" />
    <circle cx="13" cy="5" r="2" />
    <circle cx="9" cy="14" r="2" />
    <line x1="5" y1="7" x2="5" y2="10" />
    <line x1="13" y1="7" x2="13" y2="10" />
    <path d="M5 10 C5 12 9 12 9 12" />
    <path d="M13 10 C13 12 9 12 9 12" />
  </svg>
);

export const FilesIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
  </svg>
);

export const SearchIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="7.5" r="5" />
    <line x1="11" y1="11" x2="15.5" y2="15.5" />
  </svg>
);

export const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="8" y1="3" x2="8" y2="13" />
    <line x1="3" y1="8" x2="13" y2="8" />
  </svg>
);

export const SettingsIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
