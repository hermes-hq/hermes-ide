/**
 * Phase 6 (v1.0.0 redesign) — Step 1 of `SessionCreator`.
 *
 * Cardinal "How do you want to work?" mode picker.  Modes are grouped
 * by *category* so the user can see at a glance which are first-class
 * native experiences (currently Chat with Claude — v1.0; Aider native,
 * Codex native, etc. arriving in 1.x) versus the older universal
 * Terminal mode that hosts any CLI tool, versus the SSH remote.
 *
 *   - category = "native"    → first-class chat surface for one provider
 *   - category = "universal" → terminal-hosting any CLI tool
 *   - category = "remote"    → SSH connection
 *
 * Adding a future native (e.g. Aider) is purely a data change: insert
 * a row with `category: "native"` and the renderer slots it into the
 * NATIVE section automatically.
 *
 * The mode chosen here gates which fields are shown in Step 2 of the
 * SessionCreator (see playbook §8: "mode-conditional UI rules").
 */
import "../styles/components/SessionCreator.css";

export type SessionCreatorMode = "agent" | "terminal" | "ssh";
export type SessionCreatorModeCategory = "native" | "universal" | "remote";

interface ModeOption {
  id: SessionCreatorMode;
  label: string;
  description: string;
  category: SessionCreatorModeCategory;
  /** Optional callout pill, e.g. `"NEW"` for the v1.0 native mode. */
  badge?: string;
}

export const SESSION_CREATOR_MODES: ModeOption[] = [
  {
    id: "agent",
    category: "native",
    label: "Chat with Claude",
    description:
      "Real conversation with Claude on your code. Diffs, tool runs, files, plan mode. Built natively into Hermes.",
    badge: "NEW",
  },
  {
    id: "terminal",
    category: "universal",
    label: "Terminal",
    description:
      "Universal CLI host (the original Hermes mode). A shell or any AI CLI you have installed: Claude Code, Aider, Codex, Gemini, Copilot, Kiro, plain bash/zsh.",
  },
  {
    id: "ssh",
    category: "remote",
    label: "SSH",
    description:
      "Connect to a remote machine. Native chat for remote sessions arrives in v1.1.",
  },
];

const CATEGORY_LABELS: Record<SessionCreatorModeCategory, string> = {
  native: "NATIVE",
  universal: "UNIVERSAL",
  remote: "REMOTE",
};

const CATEGORY_HINTS: Record<SessionCreatorModeCategory, string> = {
  native: "first-class chat surface · v1.0",
  universal: "any CLI tool · classic mode",
  remote: "remote machine",
};

const CATEGORY_ORDER: SessionCreatorModeCategory[] = ["native", "universal", "remote"];

interface SessionCreatorModeStepProps {
  selected: SessionCreatorMode;
  onSelect: (mode: SessionCreatorMode) => void;
}

export function SessionCreatorModeStep({
  selected,
  onSelect,
}: SessionCreatorModeStepProps) {
  return (
    <div
      className="session-creator-mode-step"
      role="radiogroup"
      aria-label="How do you want to work?"
    >
      <h2 className="session-creator-mode-title">How do you want to work?</h2>
      {CATEGORY_ORDER.map((category) => {
        const modes = SESSION_CREATOR_MODES.filter((m) => m.category === category);
        if (modes.length === 0) return null;
        return (
          <div key={category} className="session-creator-mode-group">
            <div className="session-creator-mode-group-header">
              <span className="session-creator-mode-group-label">
                {CATEGORY_LABELS[category]}
              </span>
              <span className="session-creator-mode-group-hint">
                {CATEGORY_HINTS[category]}
              </span>
            </div>
            {modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={selected === mode.id}
                className={`session-creator-mode-card ${
                  selected === mode.id ? "session-creator-mode-card-selected" : ""
                }`}
                onClick={() => onSelect(mode.id)}
                data-category={mode.category}
              >
                <div className="session-creator-mode-card-header">
                  <span className="session-creator-mode-label">{mode.label}</span>
                  {mode.badge && (
                    <span className="session-creator-mode-badge">{mode.badge}</span>
                  )}
                </div>
                <div className="session-creator-mode-description">
                  {mode.description}
                </div>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
