import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Suggestion } from "./suggestionEngine";

export interface SuggestionState {
  visible: boolean;
  suggestions: Suggestion[];
  selectedIndex: number | null;
  cursorX: number;
  cursorY: number;
  cellHeight: number;
}

interface SuggestionOverlayProps {
  state: SuggestionState;
  onSelect?: (index: number) => void;
  onAccept?: (index: number) => void;
}

export function SuggestionOverlay({ state, onSelect, onAccept }: SuggestionOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [flipAbove, setFlipAbove] = useState(false);

  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el || !state.visible) return;

    const parent = el.offsetParent as HTMLElement;
    if (!parent) return;

    const overlayHeight = el.offsetHeight;
    const containerHeight = parent.clientHeight;
    setFlipAbove(state.cursorY + overlayHeight > containerHeight);
  }, [state.visible, state.cursorY, state.suggestions.length, state.selectedIndex]);

  // Scroll selected item into view when navigating with keyboard
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.selectedIndex]);

  if (!state.visible || state.suggestions.length === 0) return null;

  const top = flipAbove
    ? state.cursorY - state.cellHeight - (overlayRef.current?.offsetHeight ?? 0)
    : state.cursorY;

  return (
    <div
      ref={overlayRef}
      className={`suggestion-overlay${flipAbove ? " suggestion-overlay-above" : ""}`}
      style={{
        left: `${state.cursorX}px`,
        top: `${top}px`,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.suggestions.map((s, i) => {
        const isSelected = state.selectedIndex !== null && i === state.selectedIndex;
        return (
          <div
            key={s.text}
            ref={isSelected ? selectedRef : undefined}
            className={`suggestion-item${isSelected ? " suggestion-item-selected" : ""}`}
            onMouseEnter={() => onSelect?.(i)}
            onClick={() => onAccept?.(i)}
          >
            <div className="suggestion-item-row">
              <span className="suggestion-command">{s.text}</span>
              {s.badge && (
                <span className={`suggestion-badge suggestion-badge-${s.badge}`}>
                  {s.badge}
                </span>
              )}
            </div>
            {s.description && isSelected && (
              <div className="suggestion-description">{s.description}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
