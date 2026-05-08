/**
 * Centered "Opening new session…" overlay shown the moment the user
 * triggers a new-session flow (Cmd+N or the button).
 *
 * Renders via React portal to `document.body` so it can never be
 * clipped or stacking-context-hidden by an ancestor.  Inline critical
 * styles plus a CSS class — the critical styles guarantee visibility
 * even on the very first paint, before any external stylesheet has
 * loaded.  Class names exist for tests + theming.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §M9 + §M11.
 * Editorial Engineering — brass tracked uppercase text, no spinner.
 */
import { useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "../styles/components/SessionCreatorOpeningOverlay.css";

const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 2147483647, // maximum signed 32-bit — above EVERYTHING
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(11, 15, 20, 0.92)",
  pointerEvents: "none",
};

const TEXT_STYLE: CSSProperties = {
  fontFamily: '"Inter Tight", system-ui, sans-serif',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: "#d4a86a",
  padding: "14px 28px",
  borderTop: "1px solid rgba(212, 168, 106, 0.6)",
  borderBottom: "1px solid rgba(212, 168, 106, 0.6)",
  background: "#0d1218",
  textShadow: "0 0 8px rgba(212, 168, 106, 0.45)",
};

export function SessionCreatorOpeningOverlay() {
  // Diagnostic — proves the component actually mounts when the parent
  // gates on `sessionCreatorOpening`.  If the user reports "no loader"
  // and this log doesn't appear, the state isn't being set.
  useEffect(() => {
    const mountedAt = performance.now();
    console.log(`[opening-overlay] MOUNTED at t=${mountedAt.toFixed(0)}ms`);
    // Also assert presence in the actual DOM tree (post-paint check
    // via rAF — if this log shows null, the portal didn't attach).
    requestAnimationFrame(() => {
      const node = document.querySelector(".session-creator-opening-overlay");
      console.log(
        `[opening-overlay] post-rAF DOM check: ${
          node ? "PRESENT" : "MISSING"
        } at t=${performance.now().toFixed(0)}ms`,
      );
    });
    return () => {
      console.log(`[opening-overlay] UNMOUNTED at t=${performance.now().toFixed(0)}ms (was visible ${(performance.now() - mountedAt).toFixed(0)}ms)`);
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="session-creator-opening-overlay"
      role="status"
      aria-live="polite"
      data-testid="session-creator-opening-overlay"
      style={OVERLAY_STYLE}
    >
      <span
        className="session-creator-opening-text"
        style={TEXT_STYLE}
      >
        Opening new session…
      </span>
    </div>,
    document.body,
  );
}
