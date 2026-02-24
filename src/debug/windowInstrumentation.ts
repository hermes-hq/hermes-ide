/**
 * WINDOW-LEVEL EVENT INSTRUMENTATION
 *
 * Captures keydown, beforeinput, input, composition* events at the
 * window level. These fire BEFORE xterm.js processes them, revealing
 * the full WebKit event sequence.
 *
 * Call installWindowInstrumentation() once at app startup.
 */

import { HERMES_DEBUG, recordWindow } from "./eventRecorder";

let installed = false;

export function installWindowInstrumentation(): void {
  if (!HERMES_DEBUG || installed) return;
  installed = true;

  // Find the active session ID from the focused terminal (best effort)
  function getActiveSessionId(): string {
    const focused = document.activeElement;
    if (!focused) return "unknown";
    const container = focused.closest("[data-session-id]") as HTMLElement | null;
    return container?.dataset.sessionId ?? "unknown";
  }

  // ── keydown ──
  window.addEventListener("keydown", (e) => {
    recordWindow("keydown", {
      key: e.key,
      code: e.code,
      type: e.type,
      isComposing: e.isComposing,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      repeat: e.repeat,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  // ── keyup ──
  window.addEventListener("keyup", (e) => {
    // Only log keyup for printable keys (reduces noise)
    if (e.key.length === 1) {
      recordWindow("keyup", {
        key: e.key,
        code: e.code,
      }, { sessionId: getActiveSessionId() });
    }
  }, { capture: true });

  // ── beforeinput ──
  window.addEventListener("beforeinput", (e) => {
    recordWindow("beforeinput", {
      inputType: (e as InputEvent).inputType,
      data: (e as InputEvent).data,
      isComposing: (e as InputEvent).isComposing,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  // ── input ──
  window.addEventListener("input", (e) => {
    recordWindow("input", {
      inputType: (e as InputEvent).inputType,
      data: (e as InputEvent).data,
      isComposing: (e as InputEvent).isComposing,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  // ── compositionstart ──
  window.addEventListener("compositionstart", (e) => {
    recordWindow("compositionstart", {
      data: (e as CompositionEvent).data,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  // ── compositionupdate ──
  window.addEventListener("compositionupdate", (e) => {
    recordWindow("compositionupdate", {
      data: (e as CompositionEvent).data,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  // ── compositionend ──
  window.addEventListener("compositionend", (e) => {
    recordWindow("compositionend", {
      data: (e as CompositionEvent).data,
    }, { sessionId: getActiveSessionId() });
  }, { capture: true });

  console.log("[HERMES_DEBUG] Window instrumentation installed — capturing keydown, beforeinput, input, composition* events");
}
