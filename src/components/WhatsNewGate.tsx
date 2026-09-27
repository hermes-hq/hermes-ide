import { Suspense, useEffect, useState } from "react";
import { lazyView } from "../utils/lazyView";
import { getSetting, setSetting } from "../api/settings";
import { WHATS_NEW_LAST_SEEN_SETTING, WHATS_NEW_PREVIEW_STORAGE_KEY } from "./startupDialogSettings";

const WhatsNewDialog = lazyView("WhatsNewDialog", () => import("./WhatsNewDialog").then((m) => m.WhatsNewDialog));

function previewRequested(): boolean {
  try {
    return !!window.localStorage.getItem(WHATS_NEW_PREVIEW_STORAGE_KEY);
  } catch {
    return false;
  }
}

/**
 * Loads the "What's new" dialog only after an update (or when a preview is
 * requested), so ordinary launches never download it. On the very first
 * launch there is nothing to announce: the current version is recorded as
 * seen, exactly as the dialog itself would do.
 */
export function WhatsNewGate({ version }: { version: string }) {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (previewRequested()) {
      setNeeded(true);
      return;
    }
    let cancelled = false;
    getSetting(WHATS_NEW_LAST_SEEN_SETTING)
      .then((lastSeen) => {
        if (cancelled) return;
        if (!lastSeen) return setSetting(WHATS_NEW_LAST_SEEN_SETTING, version);
        if (lastSeen !== version) setNeeded(true);
      })
      .catch(() => {
        // Settings unavailable: say nothing, like the dialog does.
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!needed) return null;
  return (
    <Suspense fallback={null}>
      <WhatsNewDialog version={version} />
    </Suspense>
  );
}
