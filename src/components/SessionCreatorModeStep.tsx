import "../styles/components/SessionCreator.css";
import { useI18n } from "../i18n/I18nProvider";

export type SessionCreatorMode = "agent" | "terminal" | "ssh";
export type SessionCreatorModeCategory = "native" | "universal" | "remote";

interface ModeOption {
  id: SessionCreatorMode;
  labelKey: string;
  descriptionKey: string;
  category: SessionCreatorModeCategory;
  badgeKey?: string;
}

export const SESSION_CREATOR_MODES: ModeOption[] = [
  {
    id: "agent",
    category: "native",
    labelKey: "mode.agent.label",
    descriptionKey: "mode.agent.description",
    badgeKey: "mode.agent.badge",
  },
  {
    id: "terminal",
    category: "universal",
    labelKey: "mode.terminal.label",
    descriptionKey: "mode.terminal.description",
  },
  {
    id: "ssh",
    category: "remote",
    labelKey: "mode.ssh.label",
    descriptionKey: "mode.ssh.description",
  },
];

const CATEGORY_LABELS: Record<SessionCreatorModeCategory, string> = {
  native: "mode.native",
  universal: "mode.universal",
  remote: "mode.remote",
};

const CATEGORY_HINTS: Record<SessionCreatorModeCategory, string> = {
  native: "mode.nativeHint",
  universal: "mode.universalHint",
  remote: "mode.remoteHint",
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
  const { t } = useI18n();
  return (
    <div
      className="session-creator-mode-step"
      role="radiogroup"
      aria-label={t("mode.question")}
    >
      <h2 className="session-creator-mode-title">{t("mode.question")}</h2>
      {CATEGORY_ORDER.map((category) => {
        const modes = SESSION_CREATOR_MODES.filter((m) => m.category === category);
        if (modes.length === 0) return null;
        return (
          <div key={category} className="session-creator-mode-group">
            <div className="session-creator-mode-group-header">
              <span className="session-creator-mode-group-label">
                {t(CATEGORY_LABELS[category])}
              </span>
              <span className="session-creator-mode-group-hint">
                {t(CATEGORY_HINTS[category])}
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
                  <span className="session-creator-mode-label">{t(mode.labelKey)}</span>
                  {mode.badgeKey && (
                    <span className="session-creator-mode-badge">{t(mode.badgeKey)}</span>
                  )}
                </div>
                <div className="session-creator-mode-description">
                  {t(mode.descriptionKey)}
                </div>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
