/**
 * Imperative new-session opening overlay.
 *
 * History: an earlier React-based overlay never visibly painted —
 * even with portal+max-zIndex+inline-styles, React strict mode's
 * mount/cleanup/mount cycle plus heavy SessionCreator first-mount
 * meant the browser never got a clean paint frame in which the
 * overlay was on screen alone.  The user reported "no loader at all".
 *
 * This version sidesteps React entirely.  When the user triggers a
 * new session, we synchronously append a `<div>` to `document.body`
 * BEFORE any setState runs.  The browser paints it on its next frame
 * (no React work involved).  When the modal is ready, the element
 * is removed.  A minimum-visible duration ensures the user actually
 * sees it even on instant-mount machines.
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §M9 + §M11.
 */

// PERF: reduced from 1400 → 400 (still in the documented "perceptible" range
// of [400, 1500] enforced by tests). The original 1400 was a cinematic
// branding gate, but felt like a stutter on every "New Session" click —
// users have already learned the brand mark; 400ms is enough to acknowledge
// the click without making them wait. SessionCreator itself mounts in ~23ms,
// so this is roughly the user-perceived speedup per new-session open.
export const MIN_OVERLAY_MS = 400;
/** Absolute upper bound — overlay self-destructs after this even if
 *  hideOpeningOverlay is never called (e.g. SessionCreator's onReady
 *  never fires because the modal mount errored silently).  This is
 *  the safety net that prevents "loader stuck on screen forever". */
export const MAX_OVERLAY_MS = 5000;

const OVERLAY_ID = "hermes-session-creator-opening-overlay";

interface OverlayState {
  el: HTMLDivElement;
  shownAt: number;
  /** Resolved when the overlay can be torn down (min duration elapsed). */
  minElapsed: Promise<void>;
  /** Active intervals/timeouts so we can clean them on hide. */
  timers: number[];
}

let active: OverlayState | null = null;

/**
 * Synchronously inject the overlay into `document.body`.  Idempotent:
 * calling twice while the first overlay is up is a no-op.  The
 * returned object lets the caller dismiss after the modal is ready.
 */
export function showOpeningOverlay(): OverlayState {
  console.log("[opening-overlay] showOpeningOverlay() ENTRY");
  if (active) {
    console.log("[opening-overlay] showOpeningOverlay: already active, returning existing");
    return active;
  }
  if (typeof document === "undefined") {
    console.log("[opening-overlay] no document — non-browser env");
    const stubEl = { remove: () => {} } as unknown as HTMLDivElement;
    return {
      el: stubEl,
      shownAt: Date.now(),
      minElapsed: Promise.resolve(),
      timers: [],
    };
  }

  // Inject keyframes once.  Critical: CSS animations run on the GPU
  // compositor thread, NOT the JS main thread.  setInterval-driven
  // bit-flipping STOPPED during heavy SessionCreator first-mount
  // because the main thread was blocked.  By using a CSS keyframe
  // `transform: translateY` on a tall pre-rendered strip, the bit
  // stream keeps scrolling even while React is busy.
  const STYLE_ID = "hermes-session-creator-opening-style";
  // Always replace the style tag so HMR-updated keyframes take effect.
  // The previous "create only if missing" guard meant updated keyframes
  // never made it into the page after a hot reload.
  document.getElementById(STYLE_ID)?.remove();
  {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes hermes-overlay-rule-sweep {
        0%   { transform: scaleX(0); transform-origin: left center; }
        50%  { transform: scaleX(1); transform-origin: left center; }
        51%  { transform: scaleX(1); transform-origin: right center; }
        100% { transform: scaleX(0); transform-origin: right center; }
      }
      /* Equalizer bar bounce — VU-meter color mapping.
       * Bar height AND color animate together: green at the bottom
       * (calm), yellow at mid-height (warning), red at the peak
       * (clipping).  Multi-stop keyframe keeps adjacent bars at
       * different heights AND colors at any given moment. */
      @keyframes hermes-overlay-bar-bounce {
        0%   { transform: scaleY(0.20); background-color: #34d399; }
        18%  { transform: scaleY(0.75); background-color: #ffb000; }
        34%  { transform: scaleY(0.42); background-color: #34d399; }
        52%  { transform: scaleY(1.00); background-color: #ff4444; }
        66%  { transform: scaleY(0.55); background-color: #ffb000; }
        84%  { transform: scaleY(0.85); background-color: #ff8c44; }
        100% { transform: scaleY(0.20); background-color: #34d399; }
      }
    `;
    document.head.appendChild(style);
  }

  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("data-testid", "session-creator-opening-overlay");
  el.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(11,15,20,0.82)",
    // pointer-events:auto so the user can click to dismiss if the
    // modal mount silently fails (the safety net for "loader stuck").
    "pointer-events:auto",
    "cursor:pointer",
    "opacity:1",
  ].join(";");

  // Click anywhere on the backdrop → forcibly dismiss.  Belt-and-
  // suspenders alongside the MAX_OVERLAY_MS hard timeout.
  el.addEventListener("click", () => {
    console.log("[opening-overlay] user clicked overlay — forcibly dismissing");
    if (active && active.el === el) {
      for (const t of active.timers) window.clearInterval(t);
      el.remove();
      active = null;
    }
  });

  // Card — typeset fragment.  No drop shadow, no rounded corners,
  // no card border on left/right.  The hairline rules ABOVE and BELOW
  // the headline carry the structure.  The HERMES tag in tracked
  // uppercase brass + the small reference number on the right give it
  // the feel of a printer's proof.
  const card = document.createElement("div");
  card.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:14px",
    "padding:20px 32px",
    "background:#0d1218",
    "min-width:460px",
    "max-width:560px",
  ].join(";");

  // ── Top metadata row ─────────────────────────────────────────
  const metaRow = document.createElement("div");
  metaRow.style.cssText = [
    "display:flex",
    "align-items:baseline",
    "justify-content:space-between",
    "gap:18px",
  ].join(";");

  const brand = document.createElement("span");
  brand.textContent = "HERMES · NEW SESSION";
  brand.style.cssText = [
    'font-family:"Inter Tight",system-ui,sans-serif',
    "font-size:9px",
    "font-weight:600",
    "letter-spacing:0.18em",
    "text-transform:uppercase",
    "color:#d4a86a",
  ].join(";");

  // Reference number — typeset notebooks number their entries; this
  // gives the loader a sense of being a discrete item in a sequence.
  // The number is derived from time-of-day so each open feels unique.
  const ref = document.createElement("span");
  const now = new Date();
  const refNum = String(now.getHours() * 60 + now.getMinutes()).padStart(4, "0");
  ref.textContent = `№ ${refNum}`;
  ref.style.cssText = [
    'font-family:"Inter Tight",system-ui,sans-serif',
    "font-size:9px",
    "font-weight:500",
    "letter-spacing:0.16em",
    "text-transform:uppercase",
    "color:#5d6878",
    "font-variant-numeric:tabular-nums",
  ].join(";");

  metaRow.appendChild(brand);
  metaRow.appendChild(ref);

  // ── Top hairline rule ────────────────────────────────────────
  const ruleTop = document.createElement("div");
  ruleTop.style.cssText = [
    "height:1px",
    "background:rgba(212,168,106,0.6)",
    "transform-origin:left center",
    "animation:hermes-overlay-rule-sweep 1.6s ease-in-out infinite",
  ].join(";");

  // ── Headline + heartbeat cursor ──────────────────────────────
  const headlineRow = document.createElement("div");
  headlineRow.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:6px",
    "padding:6px 0",
  ].join(";");

  // ── Binary stream — CSS-driven scrolling tape of pre-rendered bits ─
  // The container is a fixed-height window.  Inside is a tall strip
  // with N pre-rendered random bit lines.  A CSS @keyframes animation
  // translates the strip upwards in `steps()` mode so each frame
  // SNAPS to the next line — looks like switches flipping at speed.
  // Runs on the compositor: keeps moving even when React is mid-mount.
  // Equalizer-bar level meter.  Bars span the FULL card width via
  // flex-grow distribution + a generous bar count.  Each bar scales
  // independently on its own phase offset so the meter looks alive
  // and chaotic.  GPU-composited (transform: scaleY) — unaffected
  // by main-thread blocking during heavy modal mount.
  const bitsWindow = document.createElement("div");
  bitsWindow.style.cssText = [
    "display:flex",
    "align-items:flex-end",
    "justify-content:space-between",
    "gap:4px",
    "height:32px",
    "padding:0",
    "width:100%",
  ].join(";");

  const BARS = 38;
  // Trick: each bar gets a random duration and random NEGATIVE
  // animation-delay so the meter looks chaotic, not wave-like.
  // Random durations break the visual rhythm — adjacent bars never
  // line up.  Negative delays start the animation as if it began
  // partway through, so the meter looks alive on the very first
  // paint frame.
  const DURATION_MIN = 2200;
  const DURATION_MAX = 3400;
  for (let i = 0; i < BARS; i++) {
    const bar = document.createElement("div");
    const dur = DURATION_MIN + Math.floor(Math.random() * (DURATION_MAX - DURATION_MIN));
    const negDelay = -Math.floor(Math.random() * dur);
    bar.style.cssText = [
      // flex:1 1 0 + min-width:0 lets bars distribute the container
      // width equally, with the fixed gap between them.  The result
      // is a meter that ALWAYS spans the card edge-to-edge no matter
      // how wide the card grows.
      "flex:1 1 0",
      "min-width:0",
      "height:32px",
      "background:#d4a86a",
      "transform-origin:bottom center",
      `animation:hermes-overlay-bar-bounce ${dur}ms ease-in-out ${negDelay}ms infinite`,
      "will-change:transform",
    ].join(";");
    bitsWindow.appendChild(bar);
  }

  // Headline: static "OPENING NEW SESSION" — the moving piece is the
  // bit stream below it.
  const headline = document.createElement("span");
  headline.textContent = "OPENING NEW SESSION";
  headline.style.cssText = [
    'font-family:"Inter Tight",system-ui,sans-serif',
    "font-size:11px",
    "font-weight:600",
    "letter-spacing:0.18em",
    "text-transform:uppercase",
    "color:#e2e8f0",
    "line-height:1.4",
  ].join(";");

  headlineRow.appendChild(headline);
  headlineRow.appendChild(bitsWindow);

  // ── Bottom hairline rule ─────────────────────────────────────
  const ruleBottom = document.createElement("div");
  ruleBottom.style.cssText = [
    "height:1px",
    "background:rgba(212,168,106,0.6)",
    "transform-origin:right center",
    "animation:hermes-overlay-rule-sweep 1.6s ease-in-out infinite",
    "animation-delay:0.4s",
  ].join(";");

  // ── Footer caption with cycling status ───────────────────────
  // Cycles through the actual stages of session-creation so the user
  // sees real motion AND understands what's happening.  Each stage
  // gets ~520ms — long enough to read, short enough to feel alive.
  const footer = document.createElement("span");
  footer.style.cssText = [
    'font-family:"Inter Tight",system-ui,sans-serif',
    "font-size:11px",
    "font-style:italic",
    "letter-spacing:0.01em",
    "color:#a0aab8",
    "min-height:1.4em",
  ].join(";");

  card.appendChild(metaRow);
  card.appendChild(ruleTop);
  card.appendChild(headlineRow);
  card.appendChild(ruleBottom);
  card.appendChild(footer);
  el.appendChild(card);
  document.body.appendChild(el);

  // (No JS animation needed for the bit stream — it's pure CSS
  // running on the GPU compositor.  The strip's transform animation
  // keeps scrolling even when React is mid-mount.)

  // ── Animation 2: cycling status line ─────────────────────────
  const STAGES = [
    "Setting the type",
    "Reading workspace",
    "Loading attached projects",
    "Spawning the agent",
    "Almost there",
  ];
  let stageIdx = 0;
  const tickStage = () => {
    footer.textContent = `· ${STAGES[stageIdx % STAGES.length]} …`;
    stageIdx++;
  };
  tickStage(); // first stage immediately
  const stageTimer = window.setInterval(tickStage, 520);

  // Diagnostic — confirm element is in DOM with sane bounds.
  const inDom = document.getElementById(OVERLAY_ID);
  const rect = inDom?.getBoundingClientRect();
  const firstBar = bitsWindow.firstElementChild as HTMLElement | null;
  const barStyle = firstBar ? getComputedStyle(firstBar) : null;
  console.log(
    `[opening-overlay] overlay DOM check: ${inDom ? "PRESENT" : "MISSING"}; ` +
      `rect=${rect ? JSON.stringify({ w: rect.width, h: rect.height }) : "n/a"}; ` +
      `bar.animationName=${barStyle?.animationName ?? "n/a"}; ` +
      `bar.animationDuration=${barStyle?.animationDuration ?? "n/a"}`,
  );

  const shownAt = Date.now();
  const minElapsed = new Promise<void>((resolve) =>
    setTimeout(resolve, MIN_OVERLAY_MS),
  );

  // Hard self-destruct — overlay removes itself after MAX_OVERLAY_MS
  // even if hideOpeningOverlay is never called (e.g., if SessionCreator's
  // onReady never fires because the mount errored out silently).  This
  // is the safety net behind the "loader stuck on screen" report.
  const selfDestruct = window.setTimeout(() => {
    if (active && active.el === el) {
      console.log(`[opening-overlay] safety-net self-destruct after ${MAX_OVERLAY_MS}ms`);
      for (const t of active.timers) window.clearInterval(t);
      el.remove();
      active = null;
    }
  }, MAX_OVERLAY_MS);

  // Note: stageTimer is the only JS-driven animation; the bit stream
  // is CSS-only.  If the main thread blocks during modal mount, the
  // stage caption may freeze — but the bits keep moving.
  // selfDestruct is the safety-net timeout above.
  active = { el, shownAt, minElapsed, timers: [stageTimer, selfDestruct] };
  return active;
}

/**
 * Remove the overlay.  Waits for the minimum-visible duration first so
 * the user actually sees it even on instant-mount machines.  Safe to
 * call multiple times; subsequent calls are no-ops.
 */
export async function hideOpeningOverlay(): Promise<void> {
  const a = active;
  if (!a) return;
  await a.minElapsed;
  // Another caller may have replaced/removed the overlay during the wait.
  if (active === a) {
    // clearInterval also clears setTimeout handles in browsers
    // (they share the same numeric handle space).
    for (const t of a.timers) {
      window.clearInterval(t);
      window.clearTimeout(t);
    }
    a.el.remove();
    active = null;
  }
}

/** Test-only: wipe the active state so tests don't leak between cases. */
export function _resetOverlayForTests(): void {
  if (active) {
    for (const t of active.timers) {
      try { (typeof window !== "undefined" ? window : globalThis).clearInterval?.(t); } catch { /* ignore */ }
    }
    active.el.remove();
    active = null;
  }
}

/** Compatibility shim for existing call sites — same shape the React
 *  approach used.  Returns `MIN_OVERLAY_MS - elapsed` clamped to
 *  [0, MIN_OVERLAY_MS]. */
export function computeOverlayDismissDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return MIN_OVERLAY_MS;
  return Math.max(0, MIN_OVERLAY_MS - elapsedMs);
}
