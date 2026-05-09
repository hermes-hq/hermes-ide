import { useState, useEffect, useCallback } from "react";
import "../styles/components/WhatsNewDialog.css";
import { changelog } from "../data/changelog";
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
  // Preview override — when localStorage has `hermesPreviewWhatsNew`
  // set to a version key that exists in `changelog`, show that
  // entry regardless of the user's last-seen / suppress state.  Used
  // before a release to verify the release notes render correctly
  // without bumping `package.json`.  Set via DevTools:
  //
  //     localStorage.setItem("hermesPreviewWhatsNew", "1.1.0");
  //     location.reload();
  //
  // Clear with `localStorage.removeItem("hermesPreviewWhatsNew")`.
  const previewVersion =
    typeof window !== "undefined"
      ? window.localStorage.getItem("hermesPreviewWhatsNew") ?? null
      : null;
  const effectiveVersion =
    previewVersion && changelog[previewVersion] ? previewVersion : version;

  useEffect(() => {
    let cancelled = false;

    // Preview mode short-circuit — show immediately, don't write
    // any settings, ignore suppress.
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

        // Fresh install — no previous version saved. Save current and don't show.
        if (!lastSeen) {
          await setSetting(SETTING_LAST_SEEN, version);
          return;
        }

        // Same version — nothing new
        if (lastSeen === version) return;

        // User permanently suppressed the dialog
        if (suppressed === "true") {
          // Still update the last-seen version so we don't re-check
          await setSetting(SETTING_LAST_SEEN, version);
          return;
        }

        // New version + not suppressed + we have changelog content for it
        if (changelog[version]) {
          setVisible(true);
        } else {
          // No changelog entry for this version — just update silently
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
    // Preview mode: don't persist anything — the user is just
    // looking at the dialog before a release.
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
      <div className="whatsnew-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="whatsnew-header">
          <span className="whatsnew-icon" aria-hidden="true">&#10024;</span>
          <span className="whatsnew-title">What&rsquo;s New</span>
          <span className="whatsnew-tag">v{effectiveVersion}</span>
        </div>
        <div className="whatsnew-body">
          <ul className="whatsnew-list">
            {entry.items.map((item, i) => (
              <li key={i} className="whatsnew-list-item">
                <span className="whatsnew-list-bullet" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
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
          <button className="whatsnew-btn" onClick={handleDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
