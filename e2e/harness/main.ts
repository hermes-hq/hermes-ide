/**
 * Minimal xterm.js test harness for Playwright WebKit composition tests.
 *
 * Applies the same composition fix as TerminalPool.ts but without Tauri/PTY.
 * All onData output is captured in window.__terminalBuffer for assertions.
 *
 * Architecture (matches TerminalPool.ts):
 *   - xterm's CompositionHelper handles ALL composition events natively
 *   - We do NOT intercept/stopPropagation on composition events
 *   - Block keydown/keypress/keyup after compositionend via customKeyEventHandler
 *   - insertText input events pass through to xterm's _inputEvent (works because
 *     _keyDownSeen=false and _keyPressHandled=false when keydown/keypress blocked)
 *   - Flag cleared on keyup (with 200ms safety timeout)
 *   - patch-package fixes _keyDownSeen ordering in xterm.js
 */
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

declare global {
  interface Window {
    __terminalBuffer: string[];
    __terminal: Terminal;
  }
}

const terminal = new Terminal({ cols: 80, rows: 24 });
const container = document.getElementById("terminal")!;
terminal.open(container);

window.__terminalBuffer = [];
window.__terminal = terminal;

// ── WKWebView dead key fix ──
//
// Two targeted fixes:
// 1. patch-package: Moves _keyDownSeen=true AFTER customKeyEventHandler check
// 2. Block keydown/keypress/keyup after compositionend; let insertText through
//    so xterm's _inputEvent processes the trailing character (e.g. "t").
//    Flag cleared on keyup (always the last event in the sequence).

let recentCompositionEnd = false;
let compositionEndSafetyTimer: ReturnType<typeof setTimeout> | null = null;

// Track compositionend so we can block the trailing keyboard events.
// Does NOT stop propagation — xterm's CompositionHelper sees all
// composition events.
container.addEventListener("compositionend", () => {
  recentCompositionEnd = true;
  // Safety fallback: clear flag after 200ms in case keyup never fires.
  if (compositionEndSafetyTimer) clearTimeout(compositionEndSafetyTimer);
  compositionEndSafetyTimer = setTimeout(() => {
    recentCompositionEnd = false;
    compositionEndSafetyTimer = null;
  }, 200);
}, true);

terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
  // Block keydown/keypress/keyup right after compositionend.
  // Clear flag on keyup (always the last event in the sequence).
  if (recentCompositionEnd) {
    if (event.type === "keyup") {
      recentCompositionEnd = false;
      if (compositionEndSafetyTimer) {
        clearTimeout(compositionEndSafetyTimer);
        compositionEndSafetyTimer = null;
      }
    }
    return false;
  }

  // Let xterm handle everything else natively.
  return true;
});

terminal.onData((data) => {
  window.__terminalBuffer.push(data);
  terminal.write(data);
});
