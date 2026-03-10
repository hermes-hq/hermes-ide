import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { isMac } from "../utils/platform";
import { resizeSession } from "../api/sessions";
import { createHistoryProvider, type HistoryProvider } from "./intelligence/historyProvider";
import { type SuggestionState } from "./intelligence/SuggestionOverlay";
import { clearShellEnvironment } from "./intelligence/shellEnvironment";
import { invalidateContext } from "./intelligence/contextAnalyzer";
import { THEMES, FONT_FAMILIES } from "./themes";
import { clearGhostOverlay } from "./ghostText";

// ─── Types ───────────────────────────────────────────────────────────

export interface PoolEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  unlistenOutput: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  attached: boolean;
  opened: boolean;
  viewport: HTMLDivElement | null;
  ghostText: string | null;
  ghostOverlay: HTMLDivElement | null;
  userScrolledUp: boolean;
  // Intelligence state
  inputBuffer: string;
  suggestionState: SuggestionState | null;
  suggestionTimer: ReturnType<typeof setTimeout> | null;
  historyProvider: HistoryProvider;
  sessionPhase: string;
  cwd: string;
}

export type SuggestionCallback = (state: SuggestionState | null) => void;

// ─── State ───────────────────────────────────────────────────────────

export const pool = new Map<string, PoolEntry>();
export const suggestionSubscribers = new Map<string, Set<SuggestionCallback>>();
/** Guard set: sessionIds currently being created (between pool.has check and pool.set) */
export const creating = new Set<string>();

// Current settings cache
export let currentSettings: Record<string, string> = {};

export function setCurrentSettings(settings: Record<string, string>): void {
  currentSettings = settings;
}

// ─── Terminal Lifecycle ──────────────────────────────────────────────

export async function createTerminal(
  sessionId: string,
  color: string,
  handleTerminalInput: (sessionId: string, data: string) => void,
): Promise<void> {
  if (pool.has(sessionId) || creating.has(sessionId)) {
    console.warn(`[TerminalPool] duplicate create for session=${sessionId}`);
    return;
  }
  creating.add(sessionId);

  const themeName = currentSettings.theme || "tron";
  const theme = THEMES[themeName] || THEMES.tron;
  const fontSize = parseInt(currentSettings.font_size || "14", 10);
  const fontFamily = FONT_FAMILIES[currentSettings.font_family || "default"] || FONT_FAMILIES.default;
  const scrollback = parseInt(currentSettings.scrollback || "10000", 10);

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  container.style.display = "none";
  container.dataset.sessionId = sessionId;

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize,
    fontFamily,
    lineHeight: 1.2,
    theme: { ...theme, cursor: color, cursorAccent: theme.background },
    allowTransparency: false,
    scrollback,
    convertEol: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => {
    shellOpen(uri).catch(console.warn);
  }));

  // Wire input → PTY (with intelligence interception)
  //
  // ARCHITECTURE: WKWebView (Tauri macOS) fires BOTH keydown AND textarea
  // input events for the same keystroke. xterm.js processes both independently,
  // which would cause onData to fire TWICE per printable character.
  //
  // attachCustomKeyEventHandler returning false for printable keydown suppresses
  // xterm's keydown→onData path. The textarea input event is the SINGLE
  // authoritative source for printable characters. Control keys, modifiers,
  // and special keys still go through keydown.
  //
  // DEAD KEY FIX: macOS dead keys (e.g. apostrophe on Brazilian Portuguese
  // keyboard) fire event.key === "Dead" (length 4), which the old
  // key-length-based check didn't suppress. The resolved character
  // then also fires via textarea → duplicate. Using an allowlist of keys
  // that MUST go through keydown ensures dead keys are suppressed.
  //
  // onBinary was removed — it was a redundant duplicate path.
  //
  // ── WKWebView dead key fix (macOS) ──
  //
  // Two targeted fixes for WKWebView (Tauri macOS) dead key composition:
  //
  // 1. patch-package (@xterm/xterm): Moves `_keyDownSeen = true` AFTER the
  //    customKeyEventHandler check in _keyDown, so when the handler returns
  //    false, _keyDownSeen stays false.
  //
  // 2. Event blocking after compositionend: After a non-combining dead key
  //    resolves (e.g. apostrophe + t on US International), WKWebView fires
  //    events in SEPARATE event loop ticks:
  //
  //      Tick 1: compositionend("'")
  //              → CompositionHelper setTimeout(0) emits "'" via onData
  //      Tick 2: keydown(key="'t", keyCode=222) → keypress(charCode=39)
  //              → input("t", insertText) → keyup("t")
  //
  //    Without blocking:
  //      - keypress has charCode=39 (apostrophe!) → emits "'" (DUPLICATE)
  //        AND sets _keyPressHandled=true
  //      - insertText("t") is skipped (_keyPressHandled=true)
  //      Result: "don''" (double apostrophe, missing 't')
  //
  //    With our fix:
  //      - compositionend sets recentCompositionEnd flag
  //      - customKeyEventHandler blocks keydown + keypress (returns false)
  //        → _keyDownSeen stays false (patch), _keyPressHandled stays false
  //      - insertText("t") reaches xterm's _inputEvent, which processes it
  //        because _keyDownSeen=false AND _keyPressHandled=false
  //      - Flag cleared on keyup (with 200ms safety timeout fallback)
  //      Result: "don't" ✓
  //
  //    IMPORTANT: setTimeout(0) does NOT work for clearing the flag —
  //    in WKWebView the setTimeout fires BEFORE the trailing keydown,
  //    making the flag useless. Clearing on keyup is reliable because
  //    keyup is always the last event in the sequence.
  //
  // xterm's CompositionHelper handles ALL composition display and data
  // injection natively — we do NOT intercept composition events.

  let recentCompositionEnd = false;
  let compositionEndSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  if (isMac) {
    // Track compositionend so we can block the trailing keyboard events.
    // Does NOT stop propagation on compositionend itself — xterm's
    // CompositionHelper sees all composition events.
    container.addEventListener("compositionend", () => {
      recentCompositionEnd = true;
      // Safety fallback: clear flag after 200ms in case keyup never fires.
      // Normal path clears on keyup (see handler below).
      if (compositionEndSafetyTimer) clearTimeout(compositionEndSafetyTimer);
      compositionEndSafetyTimer = setTimeout(() => {
        recentCompositionEnd = false;
        compositionEndSafetyTimer = null;
      }, 200);
    }, true);
  }

  terminal.attachCustomKeyEventHandler((_event: KeyboardEvent) => {
    // Block keydown/keypress/keyup right after compositionend.
    // - Blocking keydown prevents _keyDownSeen from being set (patch)
    //   and CompositionHelper.keydown() from running.
    // - Blocking keypress prevents the stale charCode (e.g. 39 for ')
    //   from emitting a duplicate character.
    // - The insertText input event is NOT blocked — it flows through
    //   xterm's _inputEvent which processes it normally because both
    //   _keyDownSeen and _keyPressHandled are false.
    // - Flag cleared on keyup (always the last event in the sequence).
    if (recentCompositionEnd) {
      if (_event.type === "keyup") {
        recentCompositionEnd = false;
        if (compositionEndSafetyTimer) {
          clearTimeout(compositionEndSafetyTimer);
          compositionEndSafetyTimer = null;
        }
      }
      return false;
    }

    // macOS: Cmd+Left/Right → Home/End (beginning/end of line)
    // xterm.js doesn't map these like native macOS terminals do.
    if (isMac && _event.type === "keydown" && _event.metaKey && !_event.altKey && !_event.ctrlKey) {
      if (_event.key === "ArrowLeft") {
        _event.preventDefault();
        handleTerminalInput(sessionId, "\x1bOH"); // Home
        return false;
      }
      if (_event.key === "ArrowRight") {
        _event.preventDefault();
        handleTerminalInput(sessionId, "\x1bOF"); // End
        return false;
      }
    }

    // Let xterm handle everything else natively.
    return true;
  });

  terminal.onData((data) => {
    handleTerminalInput(sessionId, data);
  });

  // Track user scroll position to avoid jumping during streaming
  terminal.onScroll(() => {
    const entry = pool.get(sessionId);
    if (!entry) return;
    const buf = terminal.buffer.active;
    const atBottom = buf.baseY + terminal.rows >= buf.length;
    entry.userScrolledUp = !atBottom;
  });

  // Wire PTY output → terminal
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  try {
    unlistenOutput = await listen<string>(`pty-output-${sessionId}`, (event) => {
      const entry = pool.get(sessionId);
      const scrolledUp = entry?.userScrolledUp ?? false;
      const viewportY = scrolledUp ? terminal.buffer.active.viewportY : -1;
      try {
        const binary = atob(event.payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        terminal.write(bytes);
      } catch {
        // Corrupted base64 — silently drop to avoid garbled output
        console.warn(`[TerminalPool] Failed to decode base64 PTY output for ${sessionId}, dropping chunk`);
      }
      if (scrolledUp && viewportY >= 0) {
        terminal.scrollToLine(viewportY);
      }
    });

    unlistenExit = await listen(`pty-exit-${sessionId}`, () => {
      terminal.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
    });
  } catch (err) {
    // Clean up partial resources on failure
    creating.delete(sessionId);
    unlistenOutput?.();
    unlistenExit?.();
    terminal.dispose();
    container.remove();
    throw err;
  }

  pool.set(sessionId, {
    terminal,
    fitAddon,
    container,
    unlistenOutput,
    unlistenExit,
    attached: false,
    opened: false,
    viewport: null,
    ghostText: null,
    ghostOverlay: null,
    userScrolledUp: false,
    // Intelligence
    inputBuffer: "",
    suggestionState: null,
    suggestionTimer: null,
    historyProvider: createHistoryProvider(),
    sessionPhase: "creating",
    cwd: "",
  });
  creating.delete(sessionId);
}

// ─── Attach / Detach / Destroy ───────────────────────────────────────

export function attach(sessionId: string, viewport: HTMLDivElement, autoFocus = true): void {
  const entry = pool.get(sessionId);
  if (!entry) return;

  // Detach any other terminal from this viewport
  for (const [id, e] of pool) {
    if (e.viewport === viewport && id !== sessionId) {
      detach(id);
    }
  }

  entry.container.style.display = "block";

  if (!entry.opened) {
    // First attach — open the terminal into its container
    viewport.appendChild(entry.container);
    entry.terminal.open(entry.container);
    entry.opened = true;

    // Ensure clicks on the terminal always restore keyboard focus.
    // WKWebView can lose focus after native dialogs and not recover on click.
    entry.container.addEventListener("mousedown", () => {
      requestAnimationFrame(() => {
        entry.terminal.focus();
        const textarea = entry.container.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
        if (textarea) textarea.focus({ preventScroll: true });
      });
    });

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      entry.terminal.loadAddon(webgl);
    } catch { /* canvas fallback */ }
  } else if (entry.viewport !== viewport) {
    // Re-parent
    viewport.appendChild(entry.container);
  }

  entry.viewport = viewport;
  entry.attached = true;

  // Fit and focus after paint
  requestAnimationFrame(() => {
    try {
      entry.fitAddon.fit();
      // Only scroll to bottom if user hasn't scrolled up
      if (!entry.userScrolledUp) {
        entry.terminal.scrollToBottom();
      }
    } catch { /* terminal may not be ready */ }
    if (autoFocus) entry.terminal.focus();
    resizeSession(sessionId, entry.terminal.rows, entry.terminal.cols).catch((err) => console.warn("[TerminalPool] Failed to resize session:", err));
  });
}

export function focusTerminal(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry || !entry.attached || !entry.opened) return;
  entry.terminal.focus();
  // WKWebView workaround: xterm.focus() may silently fail after a native dialog
  // steals focus. Directly find and focus the hidden textarea as a fallback.
  const textarea = entry.container.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
  if (textarea && document.activeElement !== textarea) {
    textarea.focus({ preventScroll: true });
  }
}

export function detach(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry || !entry.attached) return;
  // Clear ghost text to prevent stale overlay reappearing on re-attach
  clearGhostText(sessionId);
  entry.container.style.display = "none";
  entry.attached = false;
}

export function destroy(sessionId: string): void {
  creating.delete(sessionId); // Clean up in case destroy races with create
  const entry = pool.get(sessionId);
  if (!entry) return;
  entry.unlistenOutput?.();
  entry.unlistenExit?.();
  if (entry.suggestionTimer) clearTimeout(entry.suggestionTimer);
  entry.terminal.dispose();
  entry.container.remove();
  pool.delete(sessionId);
  suggestionSubscribers.delete(sessionId);
  // Clean up per-session shell environment and context cache
  clearShellEnvironment(sessionId);
  if (entry.cwd) invalidateContext(entry.cwd);
}

export function refitActive(): void {
  for (const entry of pool.values()) {
    if (entry.attached && entry.opened) {
      try {
        entry.fitAddon.fit();
        if (!entry.userScrolledUp) {
          entry.terminal.scrollToBottom();
        }
      } catch { /* ignore fit errors */ }
    }
  }
}

export function has(sessionId: string): boolean {
  return pool.has(sessionId);
}

export function writeScrollback(sessionId: string, text: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  // Write restored scrollback as grey text so it's visually distinct
  entry.terminal.write("\x1b[90m" + text.replace(/\n/g, "\r\n") + "\x1b[0m\r\n\x1b[90m--- session restored ---\x1b[0m\r\n");
}

// ─── Subscription System ─────────────────────────────────────────────

/** Subscribe to suggestion state changes for a session */
export function subscribeSuggestions(
  sessionId: string,
  cb: SuggestionCallback,
): () => void {
  let subs = suggestionSubscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    suggestionSubscribers.set(sessionId, subs);
  }
  subs.add(cb);

  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) suggestionSubscribers.delete(sessionId);
  };
}

export function notifySubscribers(sessionId: string, state: SuggestionState | null): void {
  const subs = suggestionSubscribers.get(sessionId);
  if (!subs) return;
  for (const cb of subs) cb(state);
}

// ─── Session Phase & CWD Updates ─────────────────────────────────────

/** Update the session phase for intelligence gating */
export function setSessionPhase(sessionId: string, phase: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  entry.sessionPhase = phase;

  // Dismiss suggestions when entering busy phase
  if (phase !== "idle" && phase !== "shell_ready") {
    entry.inputBuffer = "";
    dismissSuggestions(sessionId);
    clearGhostText(sessionId);
  }
}

/** Update the CWD for a session (triggers context cache invalidation) */
export function setSessionCwd(sessionId: string, cwd: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  // Invalidate stale project context cache for the old CWD
  if (entry.cwd && entry.cwd !== cwd) {
    invalidateContext(entry.cwd);
  }
  entry.cwd = cwd;
}

/** Get the history provider for a session (for external loading) */
export function getHistoryProvider(sessionId: string): HistoryProvider | null {
  return pool.get(sessionId)?.historyProvider ?? null;
}

// ─── Ghost Text Public API ───────────────────────────────────────────

import { renderGhostText } from "./ghostText";

export function showGhostText(sessionId: string, text: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  clearGhostOverlay(entry);
  renderGhostText(entry, text);
}

export function clearGhostText(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  clearGhostOverlay(entry);
}

// ─── Suggestion Dismissal ────────────────────────────────────────────

export function dismissSuggestions(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  dismissSuggestionsForEntry(entry);
  notifySubscribers(sessionId, null);
}

export function dismissSuggestionsForEntry(entry: PoolEntry): void {
  if (entry.suggestionTimer) {
    clearTimeout(entry.suggestionTimer);
    entry.suggestionTimer = null;
  }
  entry.suggestionState = null;
}

// ─── Cursor Position Calculation ─────────────────────────────────────

export function getCursorPixelPosition(entry: PoolEntry): { x: number; y: number } {
  try {
    const term = entry.terminal as any;
    const dims = term._core?._renderService?.dimensions;
    const opts = entry.terminal.options;
    const fontSize = opts.fontSize || 14;
    const lineHeight = opts.lineHeight || 1.2;

    if (dims) {
      const cellW = dims.css?.cell?.width ?? dims.actualCellWidth ?? (fontSize * 0.6);
      const cellH = dims.css?.cell?.height ?? dims.actualCellHeight ?? (fontSize * lineHeight);
      const cursorX = entry.terminal.buffer.active.cursorX;
      const cursorY = entry.terminal.buffer.active.cursorY;
      return {
        x: cursorX * cellW,
        y: (cursorY + 1) * cellH, // Below the cursor row
      };
    }
  } catch { /* fallback */ }
  return { x: 0, y: 0 };
}

/** Get cursor position in pixels for a session (used by TerminalPane) */
export function getCursorPosition(sessionId: string): { x: number; y: number } | null {
  const entry = pool.get(sessionId);
  if (!entry) return null;
  return getCursorPixelPosition(entry);
}
