import "../styles/components/EmptyState.css";
import { SessionHistoryEntry } from "../state/SessionContext";
import { fmt } from "../utils/platform";
import { useI18n } from "../i18n/I18nProvider";

interface EmptyStateProps {
  recentSessions: SessionHistoryEntry[];
  onNew: () => void;
  onOpenPalette: () => void;
  onToggleContext: () => void;
  onRestore: (entry: SessionHistoryEntry, restoreScrollback: boolean) => void;
}

function timeAgo(dateStr: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return t("time.justNow");
  if (diffMin < 60) return t("time.minutesAgo", { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("time.hoursAgo", { n: diffHr });
  return t("time.daysAgo", { n: Math.floor(diffHr / 24) });
}

function projectName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const usersIdx = parts.indexOf("Users");
  if (usersIdx >= 0 && parts.length > usersIdx + 2) return parts.slice(usersIdx + 2).join("/");
  const homeIdx = parts.indexOf("home");
  if (homeIdx >= 0 && parts.length > homeIdx + 2) return parts.slice(homeIdx + 2).join("/");
  return parts[parts.length - 1] || path;
}

const TITLE_CHARS = "Hermes IDE".split("");

export function EmptyState({ recentSessions, onNew, onOpenPalette, onToggleContext, onRestore }: EmptyStateProps) {
  const { t } = useI18n();
  return (
    <div className="es-stage">
      <div className="es-atmosphere" aria-hidden="true">
        <span className="es-orb es-orb-warm" />
        <span className="es-orb es-orb-cool" />
        <span className="es-grain" />
      </div>

      <div className="es-frame">
        <header className="es-masthead">
          <div className="es-eyebrow">
            <span className="es-eyebrow-dot" aria-hidden="true" />
            HERMES <span className="es-eyebrow-sep" aria-hidden="true">·</span> WORKSHOP
            <span className="es-eyebrow-sep" aria-hidden="true">·</span> v1.1
          </div>

          <h1 className="es-title" aria-label="Hermes IDE">
            {TITLE_CHARS.map((c, i) => (
              <span
                key={i}
                className={`es-title-char${c === " " ? " es-title-char-space" : ""}`}
                style={{ animationDelay: `${120 + i * 60}ms` }}
              >
                {c === " " ? "\u00a0" : c}
              </span>
            ))}
            <span className="es-title-period" aria-hidden="true">.</span>
          </h1>

          <div className="es-rule" aria-hidden="true">
            <span className="es-rule-line" />
            <span className="es-rule-glyph">❦</span>
            <span className="es-rule-line es-rule-line-short" />
          </div>

          <p className="es-tagline">
            <span className="es-tagline-mono">{t("empty.tagline")}</span>
            <span className="es-cursor" aria-hidden="true" />
          </p>
        </header>

        <section className="es-contents" aria-label={t("empty.beginSession")}>
          <div className="es-contents-label">
            <span className="es-contents-num">I.</span>
            <span className="es-contents-text">{t("empty.beginSession")}</span>
          </div>

          <div className="es-tiles">
            <button className="es-tile es-tile-primary" onClick={onNew} type="button">
              <span className="es-tile-marker" aria-hidden="true">▸</span>
              <div className="es-tile-text">
                <span className="es-tile-title">{t("empty.newSessionTitle")}</span>
                <span className="es-tile-desc">{t("empty.newSessionDesc")}</span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}N")}</kbd>
            </button>

            <button className="es-tile es-tile-secondary" onClick={onOpenPalette} type="button">
              <span className="es-tile-marker" aria-hidden="true">▢</span>
              <div className="es-tile-text">
                <span className="es-tile-title">{t("empty.commandPaletteTitle")}</span>
                <span className="es-tile-desc">{t("empty.commandPaletteDesc")}</span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}K")}</kbd>
            </button>

            <button className="es-tile es-tile-secondary" onClick={onToggleContext} type="button">
              <span className="es-tile-marker" aria-hidden="true">◇</span>
              <div className="es-tile-text">
                <span className="es-tile-title">{t("empty.contextPanelTitle")}</span>
                <span className="es-tile-desc">{t("empty.contextPanelDesc")}</span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}E")}</kbd>
            </button>
          </div>

          <p className="es-hint">{t("empty.dropFolderHint")}</p>
        </section>

        {recentSessions.length > 0 && (
          <section className="es-logbook" aria-label={t("empty.recentSessions")}>
            <div className="es-contents-label">
              <span className="es-contents-num">II.</span>
              <span className="es-contents-text">{t("empty.logbook")}</span>
              <span className="es-contents-hint">{t("empty.mostRecent")}</span>
            </div>

            <ol className="es-recent-list">
              {recentSessions.slice(0, 5).map((entry, i) => {
                const snippet = entry.scrollback_preview
                  ? entry.scrollback_preview.split("\n").find((l) => l.trim()) || ""
                  : "";
                return (
                  <li key={entry.id} className="es-recent-item-wrap">
                    <button className="es-recent-item" onClick={() => onRestore(entry, true)} type="button">
                      <span className="es-recent-edge" aria-hidden="true" />
                      <span className="es-recent-num">{`№ ${String(i + 1).padStart(2, "0")}`}</span>
                      <span className="es-recent-dot" style={{ background: entry.color }} aria-hidden="true" />
                      <div className="es-recent-body">
                        <div className="es-recent-head">
                          <span className="es-recent-label">{entry.label}</span>
                          <span className="es-recent-path">{projectName(entry.working_directory)}</span>
                          {entry.closed_at && (
                            <span className="es-recent-time">{timeAgo(entry.closed_at, t)}</span>
                          )}
                        </div>
                        {(snippet || entry.shell) && (
                          <div className="es-recent-tail">
                            {snippet && (
                              <span className="es-recent-snippet" title={snippet}>
                                ›&nbsp;{snippet.length > 90 ? snippet.slice(0, 90) + "…" : snippet}
                              </span>
                            )}
                            <span className="es-recent-chips">
                              {entry.shell && (
                                <span className="es-recent-chip">
                                  {entry.shell.split("/").pop() || entry.shell}
                                </span>
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                      <span className="es-recent-arrow" aria-hidden="true">⤍</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <footer className="es-foot" aria-hidden="true">
          <span className="es-foot-line" />
          <span className="es-foot-text">{t("empty.footer")}</span>
          <span className="es-foot-line" />
        </footer>
      </div>
    </div>
  );
}
