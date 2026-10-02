import "../styles/components/ShortcutsPanel.css";
import { useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { fmt } from "../utils/platform";
import { useI18n } from "../i18n/I18nProvider";
import { CloseButton } from "./ui";
import { isFeatureFlagEnabled } from "../featureFlags";
import { GENERATED_SHORTCUT_GROUPS } from "../generated/shortcuts";
import { visibleShortcutGroups } from "../utils/shortcuts";

// The shortcuts shown here are generated from src-tauri/src/menu/mod.rs (the
// app's native menu bar) and src/shortcuts/app-shortcuts.json (the bindings
// the app handles itself) by `node scripts/generate-shortcuts.mjs` — see
// src/generated/shortcuts.ts. Regenerate that file instead of editing shortcuts
// by hand here; a shortcut added, changed or removed in either source is what
// changes what this panel and docs/shortcuts.md show.
const VISIBLE_SHORTCUT_GROUPS = visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS);

interface ShortcutsPanelProps {
  onClose: () => void;
}

export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  const { t } = useI18n();
  // The keyboard is the panel's while it is open (not the terminal behind
  // it); Esc closes it.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { onEscape: onClose });

  return (
    <div className="shortcuts-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("shortcuts.title")}>
      <div ref={panelRef} className="shortcuts-panel" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span className="shortcuts-title">{t("shortcuts.title")}</span>
          <CloseButton className="shortcuts-close" onClick={onClose} label={t("common.close")} />
        </div>
        <div className="shortcuts-body">
          {VISIBLE_SHORTCUT_GROUPS.map((group) => (
            <div key={group.group} className="shortcuts-group">
              <div className="shortcuts-group-label">{t(group.groupKey)}</div>
              <div className="shortcuts-table">
                {group.shortcuts.map((s) => (
                  <div key={s.id} className="shortcuts-row" data-shortcut-id={s.id}>
                    <span className="shortcuts-action">{s.id === "view.git-panel" && isFeatureFlagEnabled("reviewDesk") ? t("palette.reviewDesk") : t(s.labelKey)}</span>
                    <kbd className="shortcuts-kbd">{fmt(s.keys)}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
