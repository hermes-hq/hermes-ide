import "../styles/components/SlashCommandsDropdown.css";
import { useEffect, useRef } from "react";

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  source: "builtin" | "user" | "project";
  /** Whether the command runs over stream-json (`native`) or needs
   *  an interactive PTY shelling to `claude /<cmd>` (`cli`).  When
   *  `cli`, the composer surfaces a banner instead of submitting
   *  and the user opens the embedded terminal to actually run it. */
  kind?: "native" | "cli";
}

interface SlashCommandsDropdownProps {
  items: SlashCommandItem[];
  highlightIdx: number;
  onHighlight: (idx: number) => void;
  onSelect: (idx: number) => void;
  onClose: () => void;
}

export function SlashCommandsDropdown({
  items,
  highlightIdx,
  onHighlight,
  onSelect,
  onClose,
}: SlashCommandsDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".slash-dropdown-item-active");
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
      <div className="slash-dropdown" ref={listRef} role="listbox" aria-label="Slash commands">
        <div className="slash-dropdown-empty">No matching commands</div>
      </div>
    );
  }

  return (
    <div className="slash-dropdown" ref={listRef} role="listbox" aria-label="Slash commands">
      {items.map((item, idx) => (
        <div
          key={`${item.source}:${item.command}`}
          role="option"
          aria-selected={idx === highlightIdx}
          className={`slash-dropdown-item ${idx === highlightIdx ? "slash-dropdown-item-active" : ""}`}
          onMouseEnter={() => onHighlight(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(idx);
          }}
        >
          <div className="slash-dropdown-row">
            <span className="slash-dropdown-cmd">{item.command}</span>
            {item.label && <span className="slash-dropdown-label">{item.label}</span>}
            {item.kind === "cli" ? (
              <span
                className="slash-dropdown-kind slash-dropdown-kind-cli"
                title="Runs in the embedded terminal — this command's interactive TUI can't talk over stream-json, so Hermes spawns claude /<cmd> in a small inline PTY"
              >
                ▣ terminal
              </span>
            ) : (
              <span
                className="slash-dropdown-kind slash-dropdown-kind-native"
                title="Runs in this chat — sent to Claude as a normal prompt"
              >
                ✦ in-app
              </span>
            )}
            {item.source !== "builtin" && (
              <span className={`slash-dropdown-source slash-dropdown-source-${item.source}`}>
                {item.source}
              </span>
            )}
          </div>
          {item.description && <div className="slash-dropdown-desc">{item.description}</div>}
        </div>
      ))}
    </div>
  );
}
