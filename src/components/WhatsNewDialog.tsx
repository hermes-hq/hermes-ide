import { useState, useEffect, useCallback } from "react";
import "../styles/components/WhatsNewDialog.css";
import {
  changelog,
  type ChangelogEntry,
  type ChangelogPreviewKind,
  type ChangelogSection,
} from "../data/changelog";
import { getSetting, setSetting } from "../api/settings";

const SETTING_LAST_SEEN = "last_seen_version";
const SETTING_SUPPRESS = "suppress_whats_new";

interface WhatsNewDialogProps {
  /** Current app version (from __APP_VERSION__) */
  version: string;
}

export function WhatsNewDialog({ version }: WhatsNewDialogProps) {
  const [visible, setVisible] = useState(false);
  const [suppress, setSuppress] = useState(false);
  // Preview override — see WhatsNewDialog#preview-mode in the file
  // for the DevTools snippet that activates this path.
  const previewVersion =
    typeof window !== "undefined"
      ? window.localStorage.getItem("hermesPreviewWhatsNew") ?? null
      : null;
  const effectiveVersion =
    previewVersion && changelog[previewVersion] ? previewVersion : version;

  useEffect(() => {
    let cancelled = false;

    if (previewVersion && changelog[previewVersion]) {
      setVisible(true);
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const [lastSeen, suppressed] = await Promise.all([
          getSetting(SETTING_LAST_SEEN),
          getSetting(SETTING_SUPPRESS),
        ]);

        if (cancelled) return;

        if (!lastSeen) {
          await setSetting(SETTING_LAST_SEEN, version);
          return;
        }

        if (lastSeen === version) return;

        if (suppressed === "true") {
          await setSetting(SETTING_LAST_SEEN, version);
          return;
        }

        if (changelog[version]) {
          setVisible(true);
        } else {
          await setSetting(SETTING_LAST_SEEN, version);
        }
      } catch {
        // Settings unavailable — fail silently
      }
    })();

    return () => { cancelled = true; };
  }, [version, previewVersion]);

  const handleDismiss = useCallback(async () => {
    setVisible(false);
    if (previewVersion && changelog[previewVersion]) return;
    try {
      await setSetting(SETTING_LAST_SEEN, version);
      if (suppress) {
        await setSetting(SETTING_SUPPRESS, "true");
      }
    } catch {
      // Best-effort persist
    }
  }, [version, suppress, previewVersion]);

  if (!visible) return null;

  const entry = changelog[effectiveVersion];
  if (!entry) return null;

  return (
    <div className="whatsnew-backdrop" onClick={handleDismiss}>
      <div
        className="whatsnew-dialog"
        data-accent={entry.accent ?? "default"}
        onClick={(e) => e.stopPropagation()}
      >
        <WhatsNewHero version={effectiveVersion} tagline={entry.tagline} />
        <div className="whatsnew-body">
          {entry.sections && entry.sections.length > 0 ? (
            <div className="whatsnew-sections">
              {entry.sections.map((section, idx) => (
                <SectionCard key={idx} section={section} index={idx} />
              ))}
            </div>
          ) : entry.items && entry.items.length > 0 ? (
            <ul className="whatsnew-flat-list">
              {entry.items.map((item, i) => (
                <li
                  key={i}
                  className="whatsnew-flat-item"
                  style={{ animationDelay: `${60 + i * 28}ms` }}
                >
                  <span className="whatsnew-flat-bullet" aria-hidden="true">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="whatsnew-footer">
          <label className="whatsnew-suppress">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
            />
            Don&rsquo;t show after updates
          </label>
          <div className="whatsnew-spacer" />
          <button className="whatsnew-btn whatsnew-btn-primary" onClick={handleDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function WhatsNewHero({ version, tagline }: { version: string; tagline?: string }) {
  return (
    <header className="whatsnew-hero" aria-hidden={false}>
      {/* Decorative animated mesh — accents from the active theme. */}
      <div className="whatsnew-hero-mesh" aria-hidden="true">
        <span className="whatsnew-hero-orb whatsnew-hero-orb-a" />
        <span className="whatsnew-hero-orb whatsnew-hero-orb-b" />
        <span className="whatsnew-hero-orb whatsnew-hero-orb-c" />
      </div>
      <div className="whatsnew-hero-content">
        <span className="whatsnew-hero-eyebrow">What&rsquo;s New</span>
        <h1 className="whatsnew-hero-version">v{version}</h1>
        {tagline && <p className="whatsnew-hero-tagline">{tagline}</p>}
      </div>
    </header>
  );
}

function SectionCard({ section, index }: { section: ChangelogSection; index: number }) {
  return (
    <section
      className="whatsnew-section"
      style={{ animationDelay: `${100 + index * 70}ms` }}
    >
      <div className="whatsnew-section-header">
        {section.icon && (
          <span className="whatsnew-section-icon" aria-hidden="true">
            {section.icon}
          </span>
        )}
        <h2 className="whatsnew-section-title">{section.title}</h2>
      </div>
      {section.preview && <SectionPreview kind={section.preview} />}
      {section.description && (
        <p className="whatsnew-section-desc">{section.description}</p>
      )}
      {section.items.length > 0 && (
        <ul className="whatsnew-section-list">
          {section.items.map((item, i) => (
            <li
              key={i}
              className="whatsnew-section-item"
              style={{ animationDelay: `${140 + index * 70 + i * 22}ms` }}
            >
              <span className="whatsnew-section-bullet" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      {section.hint && (
        <p className="whatsnew-section-hint">{section.hint}</p>
      )}
    </section>
  );
}

/**
 * Pure CSS micro-mockups of the new features, embedded inside section
 * cards so the user can see the change at a glance.  Each branch is
 * a small, theme-aware illustration — no dependency on the actual
 * components (rendering them in the dialog context would cascade
 * SessionContext / xterm / etc., and the look wouldn't compress
 * cleanly anyway).  Pure HTML + the styles in WhatsNewDialog.css.
 */
function SectionPreview({ kind }: { kind: ChangelogPreviewKind }) {
  return (
    <div className={`whatsnew-preview whatsnew-preview-${kind}`} aria-hidden="true">
      {kind === "timeline" && (
        <>
          {/* Mock user turn: avatar chip + accent-tinted message card. */}
          <div className="wn-tl-row" data-role="user">
            <div className="wn-tl-chip">
              <span className="wn-tl-avatar wn-tl-avatar-user" />
              <span className="wn-tl-name">You</span>
              <span className="wn-tl-time">14:27</span>
            </div>
            <div className="wn-tl-body wn-tl-body-user">
              let&rsquo;s redesign the navbar
            </div>
          </div>
          {/* Mock assistant turn: bot avatar + sans-serif prose. */}
          <div className="wn-tl-row" data-role="assistant">
            <div className="wn-tl-chip">
              <span className="wn-tl-avatar wn-tl-avatar-bot" />
              <span className="wn-tl-name">Hermes</span>
            </div>
            <div className="wn-tl-body wn-tl-body-bot">
              I&rsquo;ll start by reading the existing nav component
              and your design tokens.
            </div>
          </div>
        </>
      )}

      {kind === "slash-popover" && (
        <>
          <div className="wn-sp-input">
            <span className="wn-sp-caret">/</span>
            <span className="wn-sp-input-cursor" />
          </div>
          <div className="wn-sp-list">
            <div className="wn-sp-row">
              <code className="wn-sp-cmd">/mcp</code>
              <span className="wn-sp-desc">Manage MCP servers</span>
              <span className="wn-sp-badge wn-sp-badge-cli">▣ terminal</span>
            </div>
            <div className="wn-sp-row wn-sp-row-active">
              <code className="wn-sp-cmd">/telegram:configure</code>
              <span className="wn-sp-desc">Set up Telegram</span>
              <span className="wn-sp-badge wn-sp-badge-native">✦ in-app</span>
            </div>
            <div className="wn-sp-row">
              <code className="wn-sp-cmd">/agents</code>
              <span className="wn-sp-desc">Manage subagents</span>
              <span className="wn-sp-badge wn-sp-badge-cli">▣ terminal</span>
            </div>
            <div className="wn-sp-row">
              <code className="wn-sp-cmd">/recap</code>
              <span className="wn-sp-desc">Summarize this session</span>
              <span className="wn-sp-badge wn-sp-badge-native">✦ in-app</span>
            </div>
          </div>
        </>
      )}

      {kind === "mcp-row" && (
        <>
          <div className="wn-mcp-row">
            <span className="wn-mcp-dot wn-mcp-dot-ok" />
            <span className="wn-mcp-name">context7</span>
            <span className="wn-mcp-status wn-mcp-status-ok">connected</span>
          </div>
          <div className="wn-mcp-explain">
            Connected — server is responding to tool calls.
          </div>
          <div className="wn-mcp-spec">
            <span className="wn-mcp-label">Transport</span>
            <span className="wn-mcp-transport">stdio</span>
            <span className="wn-mcp-label">Command</span>
            <code className="wn-mcp-code">npx -y @upstash/context7-mcp</code>
            <span className="wn-mcp-label">Env</span>
            <span className="wn-mcp-chips">
              <span className="wn-mcp-chip">CONTEXT7_API_KEY</span>
              <span className="wn-mcp-chip">DEBUG</span>
            </span>
          </div>
          <div className="wn-mcp-actions">
            <span className="wn-mcp-action">restart</span>
            <span className="wn-mcp-action wn-mcp-action-deny">remove</span>
          </div>
        </>
      )}

      {kind === "perm-buttons" && (
        <>
          <div className="wn-perm-prompt">
            <span className="wn-perm-icon">⚠</span>
            <span className="wn-perm-text">Run <code>git status -s</code>?</span>
          </div>
          <div className="wn-perm-actions">
            <span className="wn-perm-btn">Deny</span>
            <span className="wn-perm-btn">Edit input</span>
            <span className="wn-perm-spacer" />
            <span className="wn-perm-btn wn-perm-btn-secondary">Always allow (Bash)</span>
            <span className="wn-perm-btn wn-perm-btn-primary">Approve once</span>
          </div>
        </>
      )}

      {kind === "embedded-terminal" && (
        <>
          <div className="wn-term-header">
            <span className="wn-term-dot" />
            <code className="wn-term-cmd">claude → /mcp</code>
            <span className="wn-term-status">running</span>
          </div>
          <div className="wn-term-body">
            <div className="wn-term-line">claude.ai Gmail · ✓ connected</div>
            <div className="wn-term-line">claude.ai Drive · ✓ connected</div>
            <div className="wn-term-line wn-term-line-prompt">
              <span className="wn-term-chevron">❯</span> /mcp
            </div>
          </div>
        </>
      )}

      {kind === "classic-toggle" && (
        <>
          {/* Side-by-side: modern (left) vs classic (right). */}
          <div className="wn-ct-pair">
            <div className="wn-ct-side wn-ct-side-modern">
              <div className="wn-ct-label">Modern</div>
              <div className="wn-ct-row">
                <span className="wn-tl-avatar wn-tl-avatar-user" />
                <span className="wn-ct-name">You</span>
              </div>
              <div className="wn-ct-body wn-ct-body-modern">
                let&rsquo;s redesign the navbar
              </div>
            </div>
            <div className="wn-ct-side wn-ct-side-classic">
              <div className="wn-ct-label">Classic</div>
              <div className="wn-ct-row wn-ct-row-classic">
                <span className="wn-ct-name-classic">YOU · 14:27</span>
              </div>
              <div className="wn-ct-body wn-ct-body-classic">
                <em>let&rsquo;s redesign the navbar</em>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Re-export for tests
export type { ChangelogEntry };
