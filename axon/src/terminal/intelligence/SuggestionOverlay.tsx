import { type Suggestion } from "./suggestionEngine";

export interface SuggestionState {
  visible: boolean;
  suggestions: Suggestion[];
  selectedIndex: number;
  cursorX: number;
  cursorY: number;
}

interface SuggestionOverlayProps {
  state: SuggestionState;
}

export function SuggestionOverlay({ state }: SuggestionOverlayProps) {
  if (!state.visible || state.suggestions.length === 0) return null;

  return (
    <div
      className="suggestion-overlay"
      style={{
        left: `${state.cursorX}px`,
        top: `${state.cursorY}px`,
      }}
    >
      {state.suggestions.map((s, i) => (
        <div
          key={s.text}
          className={`suggestion-item${i === state.selectedIndex ? " suggestion-item-selected" : ""}`}
        >
          <div className="suggestion-item-row">
            <span className="suggestion-command">{s.text}</span>
            {s.badge && (
              <span className={`suggestion-badge suggestion-badge-${s.badge}`}>
                {s.badge}
              </span>
            )}
          </div>
          {s.description && i === state.selectedIndex && (
            <div className="suggestion-description">{s.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}
