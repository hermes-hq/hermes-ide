import { useState, useEffect, useCallback } from "react";
import "../styles/components/WhatsNewDialog.css";
import { changelog, type ChangelogEntry, type ChangelogSection } from "../data/changelog";
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

// Re-export for tests
export type { ChangelogEntry };
