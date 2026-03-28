import { type ReactNode, useRef, useState, useEffect } from "react";
import { Blocks, Settings } from "lucide-react";
import "../styles/components/ActivityBar.css";

export interface ActivityBarTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

interface ActivityBarAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

interface ActivityBarProps {
  side: "left" | "right";
  tabs: ActivityBarTab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  topAction?: ActivityBarAction;
  pinnedTabs?: ActivityBarTab[];
  bottomActions?: ActivityBarAction[];
  /** @deprecated Use bottomActions instead */
  bottomAction?: ActivityBarAction;
}

/**
 * Returns true when a mousedown on a reorderable tab should be treated as
 * a plain click instead of starting a drag sequence.
 */
export function shouldDirectClick(hasReorder: boolean, tabCount: number): boolean {
  return !hasReorder || tabCount < 2;
}

export function ActivityBar({ side, tabs, activeTabId, onTabClick, onReorder, topAction, pinnedTabs, bottomActions, bottomAction }: ActivityBarProps) {
  const resolvedBottomActions = bottomActions ?? (bottomAction ? [bottomAction] : []);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const dropIndexRef = useRef<number | null>(null);

  // Clean up drag state on unmount
  useEffect(() => {
    return () => {
      document.querySelector(".activity-bar-ghost")?.remove();
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent, tabId: string) => {
    if (!onReorder || tabs.length < 2) {
      onTabClick(tabId);
      return;
    }
    e.preventDefault();
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    dragging.current = false;

    const tabEl = (e.currentTarget as HTMLElement);

    const onMouseMove = (me: MouseEvent) => {
      if (!mouseDownPos.current) return;
      const dy = Math.abs(me.clientY - mouseDownPos.current.y);
      const dx = Math.abs(me.clientX - mouseDownPos.current.x);

      if (!dragging.current && dy + dx > 5) {
        dragging.current = true;
        setDragId(tabId);

        // Create ghost
        const rect = tabEl.getBoundingClientRect();
        const ghost = document.createElement("div");
        ghost.className = "activity-bar-ghost";
        ghost.style.cssText = `
          position: fixed; z-index: 9999; pointer-events: none;
          width: ${rect.width}px; height: ${rect.height}px;
          background: var(--bg-hover); border: 1px solid var(--accent);
          border-radius: var(--radius); opacity: 0.9;
          display: flex; align-items: center; justify-content: center;
          color: var(--accent);
        `;
        ghost.innerHTML = tabEl.querySelector(".activity-bar-icon-wrap")?.innerHTML ?? "";
        document.body.appendChild(ghost);
      }

      if (dragging.current) {
        const ghost = document.querySelector(".activity-bar-ghost") as HTMLElement;
        if (ghost) {
          ghost.style.left = `${me.clientX - 16}px`;
          ghost.style.top = `${me.clientY - 16}px`;
        }

        // Calculate drop index from mouse Y position
        if (tabsRef.current) {
          const tabEls = tabsRef.current.querySelectorAll("[data-tab-id]");
          let idx = tabs.length;
          for (let i = 0; i < tabEls.length; i++) {
            const r = tabEls[i].getBoundingClientRect();
            if (me.clientY < r.top + r.height / 2) {
              idx = i;
              break;
            }
          }
          setDropIndex(idx);
          dropIndexRef.current = idx;
        }
      }
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.querySelector(".activity-bar-ghost")?.remove();

      const di = dropIndexRef.current;
      if (dragging.current && di !== null) {
        // Build new order
        const currentIdx = tabs.findIndex(t => t.id === tabId);
        if (currentIdx !== -1 && di !== currentIdx && di !== currentIdx + 1) {
          const ids = tabs.map(t => t.id);
          const [moved] = ids.splice(currentIdx, 1);
          const insertAt = di > currentIdx ? di - 1 : di;
          ids.splice(insertAt, 0, moved);
          onReorder(ids);
        }
      } else if (!dragging.current) {
        // Was a click, not a drag
        onTabClick(tabId);
      }

      setDragId(null);
      setDropIndex(null);
      dropIndexRef.current = null;
      mouseDownPos.current = null;
      dragging.current = false;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div className={`activity-bar activity-bar-${side}`}>
      {topAction && (
        <button
          className={`activity-bar-action activity-bar-expandable activity-bar-expand-${side}`}
          onClick={topAction.onClick}
        >
          <span className="activity-bar-icon-wrap">{topAction.icon}</span>
          <span className="activity-bar-label">{topAction.label}</span>
        </button>
      )}
      {pinnedTabs && pinnedTabs.map((tab) => (
        <button
          key={tab.id}
          className={`activity-bar-tab activity-bar-expandable activity-bar-expand-${side}${activeTabId === tab.id ? " activity-bar-tab-active" : ""}`}
          onClick={() => onTabClick(tab.id)}
        >
          <span className="activity-bar-icon-wrap">
            {tab.icon}
            {tab.badge != null && tab.badge > 0 && (
              <span className="activity-bar-badge">{tab.badge}</span>
            )}
          </span>
          <span className="activity-bar-label">{tab.label}</span>
        </button>
      ))}
      {(topAction || (pinnedTabs && pinnedTabs.length > 0)) && (
        <div className="activity-bar-separator" />
      )}
      <div ref={tabsRef} className="activity-bar-tabs-reorderable">
        {tabs.map((tab, i) => (
          <div key={tab.id} className="activity-bar-tab-slot">
            {dragId && dropIndex === i && (
              <div className="activity-bar-drop-indicator" />
            )}
            <button
              data-tab-id={tab.id}
              className={`activity-bar-tab activity-bar-expandable activity-bar-expand-${side}${activeTabId === tab.id ? " activity-bar-tab-active" : ""}${dragId === tab.id ? " activity-bar-tab-dragging" : ""}`}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              onClick={onReorder ? undefined : () => onTabClick(tab.id)}
            >
              <span className="activity-bar-icon-wrap">
                {tab.icon}
                {tab.badge != null && tab.badge > 0 && (
                  <span className="activity-bar-badge">{tab.badge}</span>
                )}
              </span>
              <span className="activity-bar-label">{tab.label}</span>
            </button>
          </div>
        ))}
        {dragId && dropIndex === tabs.length && (
          <div className="activity-bar-drop-indicator" />
        )}
      </div>
      {resolvedBottomActions.length > 0 && (
        <>
          <div className="activity-bar-bottom-spacer" />
          {resolvedBottomActions.map((action, i) => (
            <button
              key={i}
              className={`activity-bar-action activity-bar-expandable activity-bar-expand-${side}`}
              onClick={action.onClick}
            >
              <span className="activity-bar-icon-wrap">{action.icon}</span>
              <span className="activity-bar-label">{action.label}</span>
            </button>
          ))}
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

export const PluginsIcon = <Blocks size={18} strokeWidth={1.5} />;

export const SettingsIcon = <Settings size={18} strokeWidth={1.5} />;
