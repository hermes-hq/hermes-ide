/**
 * Empty-state hero — what the user sees when there are no sessions
 * open.  This is the 0→1 moment of the entire app, so it's designed
 * as a piece of typography, not a button row:
 *
 *   - Newsreader serif sets a "hand-bound logbook" tone — Hermes
 *     already loads it for the agent surface; here it gets the lead
 *     role on the title cut.
 *   - JetBrains Mono carries the operator voice (subtitle, shortcut
 *     keys, command palette).
 *   - Inter Tight handles connective tissue (paragraph copy, hints).
 *
 * Composition is deliberately asymmetric: a serif title cut by a
 * brass rule + ornament glyph, action tiles laid out like a printed
 * contents page, recent sessions treated as a margin-numbered
 * logbook list.
 *
 * Motion: a one-shot orchestrated reveal on mount — title characters
 * stagger in, the brass rule grows from the left, tiles fade up,
 * recent sessions slide in last.  Reduced-motion drops it all to
 * static.  No looping animations except the cursor block.
 */
import "../styles/components/EmptyState.css";
import { SessionHistoryEntry } from "../state/SessionContext";
import { fmt } from "../utils/platform";

interface EmptyStateProps {
  recentSessions: SessionHistoryEntry[];
  onNew: () => void;
  onRestore: (entry: SessionHistoryEntry, restoreScrollback: boolean) => void;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function projectName(path: string): string {
  // Normalize backslashes (Windows) to forward slashes for consistent splitting
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  // macOS/Windows: /Users/name/... or C:/Users/name/...
  const usersIdx = parts.indexOf("Users");
  if (usersIdx >= 0 && parts.length > usersIdx + 2) return parts.slice(usersIdx + 2).join("/");
  // Linux: /home/name/...
  const homeIdx = parts.indexOf("home");
  if (homeIdx >= 0 && parts.length > homeIdx + 2) return parts.slice(homeIdx + 2).join("/");
  return parts[parts.length - 1] || path;
}

const TITLE_CHARS = "Hermes".split("");

export function EmptyState({ recentSessions, onNew, onRestore }: EmptyStateProps) {
  return (
    <div className="es-stage">
      {/* Atmospheric layer — soft brass + cool orbs and a faint paper
       * grain.  Sits behind everything; pointer-events: none. */}
      <div className="es-atmosphere" aria-hidden="true">
        <span className="es-orb es-orb-warm" />
        <span className="es-orb es-orb-cool" />
        <span className="es-grain" />
      </div>

      <div className="es-frame">
        {/* ── Masthead ─────────────────────────────────────── */}
        <header className="es-masthead">
          <div className="es-eyebrow">
            <span className="es-eyebrow-dot" aria-hidden="true" />
            HERMES <span className="es-eyebrow-sep" aria-hidden="true">·</span> WORKSHOP
            <span className="es-eyebrow-sep" aria-hidden="true">·</span> v1.1
          </div>

          <h1 className="es-title" aria-label="Hermes">
            {TITLE_CHARS.map((c, i) => (
              <span
                key={i}
                className="es-title-char"
                style={{ animationDelay: `${120 + i * 60}ms` }}
              >
                {c}
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
            <span className="es-tagline-mono">an instrument panel for working with code &amp; agents.</span>
            <span className="es-cursor" aria-hidden="true" />
          </p>
        </header>

        {/* ── Contents page — primary actions + shortcuts ──── */}
        <section className="es-contents" aria-label="Start a session">
          <div className="es-contents-label">
            <span className="es-contents-num">I.</span>
            <span className="es-contents-text">Begin a session</span>
          </div>

          <div className="es-tiles">
            <button
              className="es-tile es-tile-primary"
              onClick={onNew}
              type="button"
            >
              <span className="es-tile-marker" aria-hidden="true">▸</span>
              <div className="es-tile-text">
                <span className="es-tile-title">New session</span>
                <span className="es-tile-desc">
                  Open Claude in agent mode, attach folders, start typing.
                </span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}N")}</kbd>
            </button>

            <div className="es-tile es-tile-secondary">
              <span className="es-tile-marker" aria-hidden="true">▢</span>
              <div className="es-tile-text">
                <span className="es-tile-title">Command palette</span>
                <span className="es-tile-desc">
                  Jump to settings, themes, recent sessions, anywhere.
                </span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}K")}</kbd>
            </div>

            <div className="es-tile es-tile-secondary">
              <span className="es-tile-marker" aria-hidden="true">◇</span>
              <div className="es-tile-text">
                <span className="es-tile-title">Context panel</span>
                <span className="es-tile-desc">
                  MCP servers, memory, permissions — show or hide.
                </span>
              </div>
              <kbd className="es-tile-kbd">{fmt("{mod}E")}</kbd>
            </div>
          </div>

          <p className="es-hint">
            or drop a folder onto the window to bind it as a workspace.
          </p>
        </section>

        {/* ── Logbook — recent sessions, numbered like marginalia ── */}
        {recentSessions.length > 0 && (
          <section className="es-logbook" aria-label="Recent sessions">
            <div className="es-contents-label">
              <span className="es-contents-num">II.</span>
              <span className="es-contents-text">Logbook</span>
              <span className="es-contents-hint">most-recent first</span>
            </div>

            <ol className="es-recent-list">
              {recentSessions.slice(0, 5).map((entry, i) => (
                <li key={entry.id} className="es-recent-item-wrap">
                  <button
                    className="es-recent-item"
                    onClick={() => onRestore(entry, true)}
                    type="button"
                  >
                    <span className="es-recent-num">{`№ ${String(i + 1).padStart(2, "0")}`}</span>
                    <span
                      className="es-recent-dot"
                      style={{ background: entry.color }}
                      aria-hidden="true"
                    />
                    <span className="es-recent-label">{entry.label}</span>
                    <span className="es-recent-path">{projectName(entry.working_directory)}</span>
                    {entry.closed_at && (
                      <span className="es-recent-time">{timeAgo(entry.closed_at)}</span>
                    )}
                    <span className="es-recent-arrow" aria-hidden="true">⤍</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* ── Footer ──────────────────────────────────────── */}
        <footer className="es-foot" aria-hidden="true">
          <span className="es-foot-line" />
          <span className="es-foot-text">made for the workshop</span>
          <span className="es-foot-line" />
        </footer>
      </div>
    </div>
  );
}
