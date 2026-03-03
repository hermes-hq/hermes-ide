import "../styles/components/CommandsPopover.css";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { ActionTemplate, ActionEvent } from "../types/session";

interface CommandsPopoverProps {
  actions: ActionTemplate[];
  recentActions: ActionEvent[];
  onExecute: (command: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

export function CommandsPopover({ actions, recentActions, onExecute, onClose, anchorRect }: CommandsPopoverProps) {
  const [filter, setFilter] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recentCmds = useMemo(
    () => new Set(recentActions.map((a) => a.command)),
    [recentActions],
  );

  const filtered = useMemo(() => {
    if (!filter) return actions;
    const q = filter.toLowerCase();
    return actions.filter(
      (a) =>
        a.command.toLowerCase().includes(q) ||
        a.label.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [actions, filter]);

  // Group filtered actions by category, preserving order
  const grouped = useMemo(() => {
    const map = new Map<string, ActionTemplate[]>();
    for (const action of filtered) {
      const list = map.get(action.category) || [];
      list.push(action);
      map.set(action.category, list);
    }
    return map;
  }, [filtered]);

  // Flat list for keyboard navigation
  const flatItems = useMemo(() => {
    const items: ActionTemplate[] = [];
    for (const [, categoryActions] of grouped) {
      items.push(...categoryActions);
    }
    return items;
  }, [grouped]);

  // Reset focus when filter changes
  useEffect(() => {
    setFocusedIdx(-1);
  }, [filter]);

  // Auto-focus search input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-focused="true"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIdx((prev) => (prev + 1) % flatItems.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIdx((prev) => (prev <= 0 ? flatItems.length - 1 : prev - 1));
          break;
        case "Enter":
          e.preventDefault();
          if (focusedIdx >= 0 && focusedIdx < flatItems.length) {
            onExecute(flatItems[focusedIdx].command);
            onClose();
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [flatItems, focusedIdx, onExecute, onClose],
  );

  // Position the popover below the anchor, clamped to viewport
  const style = useMemo(() => {
    const top = anchorRect.bottom + 4;
    let left = anchorRect.right - 280;
    if (left < 8) left = 8;
    return { top, left };
  }, [anchorRect]);

  return (
    <>
      <div className="commands-popover-overlay" onMouseDown={onClose} />
      <div className="commands-popover" style={style} onKeyDown={handleKeyDown}>
        <div className="commands-popover-search">
          <input
            ref={inputRef}
            type="text"
            placeholder="Filter commands…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="commands-popover-list" ref={listRef}>
          {flatItems.length === 0 && (
            <div className="commands-popover-empty">No matching commands</div>
          )}
          {Array.from(grouped.entries()).map(([category, categoryActions]) => (
            <div key={category}>
              <div className="commands-popover-category">{category}</div>
              {categoryActions.map((action) => {
                const idx = flatItems.indexOf(action);
                const isRecent = recentCmds.has(action.command);
                return (
                  <button
                    key={action.command}
                    className={`commands-popover-item ${isRecent ? "commands-popover-item-recent" : ""}`}
                    data-focused={idx === focusedIdx ? "true" : undefined}
                    onMouseEnter={() => setFocusedIdx(idx)}
                    onClick={() => {
                      onExecute(action.command);
                      onClose();
                    }}
                  >
                    <span className="commands-popover-item-cmd">{action.command}</span>
                    <span className="commands-popover-item-desc">{action.description}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
