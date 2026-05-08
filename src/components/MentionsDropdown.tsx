import "../styles/components/MentionsDropdown.css";
import { useEffect, useRef } from "react";

interface MentionsDropdownProps {
  /** Already fuzzy-filtered, ranked, capped list of file paths. */
  items: string[];
  /** Indices of `getKey(item)` characters that matched (for highlighting). */
  matches: number[][];
  highlightIdx: number;
  onHighlight: (idx: number) => void;
  onSelect: (idx: number) => void;
  onClose: () => void;
}

export function MentionsDropdown({
  items,
  matches,
  highlightIdx,
  onHighlight,
  onSelect,
  onClose,
}: MentionsDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".mentions-dropdown-item-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!listRef.current) return;
      if (!listRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);

  if (items.length === 0) {
    return (
      <div className="mentions-dropdown" ref={listRef} role="listbox" aria-label="File suggestions">
        <div className="mentions-dropdown-empty">No matching files</div>
      </div>
    );
  }

  return (
    <div className="mentions-dropdown" ref={listRef} role="listbox" aria-label="File suggestions">
      {items.map((path, idx) => (
        <div
          key={path}
          role="option"
          aria-selected={idx === highlightIdx}
          className={`mentions-dropdown-item ${idx === highlightIdx ? "mentions-dropdown-item-active" : ""}`}
          onMouseEnter={() => onHighlight(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(idx);
          }}
        >
          {renderHighlighted(path, matches[idx] ?? [])}
        </div>
      ))}
    </div>
  );
}

function renderHighlighted(text: string, indices: number[]): React.ReactNode {
  if (indices.length === 0) return text;
  const parts: React.ReactNode[] = [];
  const set = new Set(indices);
  let buf = "";
  let bufHighlighted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const hit = set.has(i);
    if (hit !== bufHighlighted) {
      if (buf) parts.push(bufHighlighted ? <mark key={parts.length}>{buf}</mark> : <span key={parts.length}>{buf}</span>);
      buf = ch;
      bufHighlighted = hit;
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(bufHighlighted ? <mark key={parts.length}>{buf}</mark> : <span key={parts.length}>{buf}</span>);
  return <>{parts}</>;
}
