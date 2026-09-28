// ─── Does a Hermes window have the keyboard focus? ────────────────────
//
// F12 suppresses notifications for the session you are looking at, which
// needs "is this window focused". The answer comes from the webview
// (document.hasFocus plus focus/blur events).
//
// Test builds can pin the answer: a hands-free test must not take the
// keyboard focus from whoever uses the machine, so a real-app scenario says
// "the window is focused" through the e2e hooks instead of raising it.

type Listener = () => void;

let override: boolean | null = null;
const listeners = new Set<Listener>();
let attached = false;

function notify(): void {
  for (const l of [...listeners]) l();
}

function attach(): void {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
  document.addEventListener("visibilitychange", notify);
}

export function isWindowFocused(): boolean {
  if (override !== null) return override;
  if (typeof document === "undefined") return false;
  return document.visibilityState !== "hidden" && document.hasFocus();
}

export function subscribeWindowFocus(listener: Listener): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test builds only (the e2e hooks): pin the answer, or null to follow the window. */
export function setWindowFocusOverride(value: boolean | null): void {
  override = value;
  notify();
}
