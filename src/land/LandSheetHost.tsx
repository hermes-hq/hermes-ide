import { Suspense, useEffect, useState } from "react";
import { isFeatureFlagEnabled } from "../featureFlags";
import { lazyView } from "../utils/lazyView";

// Fetched the first time a sheet opens, never at startup.
const LandSheet = lazyView("LandSheet", () => import("./LandSheet").then((m) => m.LandSheet));

/** Window event that opens the Land sheet for a session's worktree. */
export const OPEN_LAND_SHEET_EVENT = "hermes:open-land-sheet";
/**
 * Window event sent when the Land sheet closes: `{ sessionId, landed }`.
 * `landed` is true only after a land or an archive went through (and was
 * not undone); the Review Desk the sheet was opened from stays open under
 * it and closes only then — Cancel or Close brings the person back to it.
 */
export const LAND_SHEET_CLOSED_EVENT = "hermes:land-sheet-closed";

export interface LandSheetClosed {
  readonly sessionId: string;
  readonly landed: boolean;
}

interface Target {
  sessionId: string;
  projectId: string;
  /** Bumps on every open so reopening starts fresh. */
  key: number;
}

let openFor: string | null = null;

/** Whether a Land sheet is open (the desk under it leaves its keys alone). */
export function isLandSheetOpen(): boolean {
  return openFor !== null;
}

export function openLandSheet(sessionId: string, projectId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_LAND_SHEET_EVENT, { detail: { sessionId, projectId } }));
}

/**
 * Lives at the app root (not inside the session's panel) so the sheet —
 * with its Undo — stays open after an archive closes the session.
 * Behind the "landSheet" feature flag.
 */
export function LandSheetHost() {
  const enabled = isFeatureFlagEnabled("landSheet");
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: unknown; projectId?: unknown }>).detail;
      if (typeof detail?.sessionId !== "string" || typeof detail?.projectId !== "string") return;
      openFor = detail.sessionId;
      setTarget((prev) => ({
        sessionId: detail.sessionId as string,
        projectId: detail.projectId as string,
        key: (prev?.key ?? 0) + 1,
      }));
    };
    window.addEventListener(OPEN_LAND_SHEET_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LAND_SHEET_EVENT, onOpen);
  }, [enabled]);

  if (!enabled || !target) return null;
  return (
    <Suspense fallback={null}>
      <LandSheet
        key={target.key}
        sessionId={target.sessionId}
        projectId={target.projectId}
        onClose={(landed?: boolean) => {
          openFor = null;
          setTarget(null);
          const detail: LandSheetClosed = { sessionId: target.sessionId, landed: landed === true };
          window.dispatchEvent(new CustomEvent(LAND_SHEET_CLOSED_EVENT, { detail }));
        }}
      />
    </Suspense>
  );
}
