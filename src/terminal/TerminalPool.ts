import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { writeToSession, resizeSession } from "../api/sessions";
import { suggest } from "./intelligence/suggestionEngine";
import { resolveIntent, getIntentSuggestions } from "./intentCommands";
import { type ProjectContext, getCachedContext, invalidateContext } from "./intelligence/contextAnalyzer";
import { createHistoryProvider, type HistoryProvider } from "./intelligence/historyProvider";
import { type SuggestionState } from "./intelligence/SuggestionOverlay";
import {
  isIntelligenceDisabled,
  shouldShowGhostText,
  shouldShowOverlay,
  shouldConsumeTab,
  clearShellEnvironment,
} from "./intelligence/shellEnvironment";

// ─── Helpers ────────────────────────────────────────────────────────

/** UTF-8-safe base64 encoding (handles characters outside Latin-1 range) */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary);
}

// ─── Types ───────────────────────────────────────────────────────────

interface PoolEntry {
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
  // Intelligence state
  inputBuffer: string;
  suggestionState: SuggestionState | null;
  suggestionTimer: ReturnType<typeof setTimeout> | null;
  historyProvider: HistoryProvider;
  sessionPhase: string;
  cwd: string;
}

type SuggestionCallback = (state: SuggestionState | null) => void;

// ─── State ───────────────────────────────────────────────────────────

const pool = new Map<string, PoolEntry>();
const suggestionSubscribers = new Map<string, Set<SuggestionCallback>>();

const SUGGESTION_DEBOUNCE_MS = 50;

// ─── Themes & Fonts ──────────────────────────────────────────────────

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    background: "#0B0F14",
    foreground: "#c8d6e5",
    selectionBackground: "#33ff9933",
    selectionForeground: "#ffffff",
    cursor: "#33ff99",
    black: "#0B0F14", red: "#ff4444", green: "#33ff99", yellow: "#ffb000",
    blue: "#7b93db", magenta: "#a78bfa", cyan: "#56d4dd", white: "#c8d6e5",
    brightBlack: "#4a5568", brightRed: "#ff6666", brightGreen: "#66ffbb",
    brightYellow: "#ffc844", brightBlue: "#99b3eb", brightMagenta: "#c4a8ff",
    brightCyan: "#7eeaea", brightWhite: "#e8f0fe",
  },
  dimmed: {
    background: "#080c10",
    foreground: "#7f8c9b",
    selectionBackground: "#33ff9922",
    selectionForeground: "#ffffff",
    cursor: "#33ff99",
    black: "#080c10", red: "#cc3333", green: "#29cc7a", yellow: "#cc8d00",
    blue: "#6278b0", magenta: "#8670c8", cyan: "#44a9b1", white: "#7f8c9b",
    brightBlack: "#3a4555", brightRed: "#ff5555", brightGreen: "#55dd99",
    brightYellow: "#ddaa33", brightBlue: "#7b93db", brightMagenta: "#a78bfa",
    brightCyan: "#56d4dd", brightWhite: "#c8d6e5",
  },
};

const FONT_FAMILIES: Record<string, string> = {
  default: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
  fira: "'Fira Code', 'SF Mono', Menlo, monospace",
  jetbrains: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
  cascadia: "'Cascadia Code', 'SF Mono', Menlo, monospace",
  menlo: "Menlo, 'SF Mono', monospace",
};

// Current settings cache
let currentSettings: Record<string, string> = {};

// ─── Settings ────────────────────────────────────────────────────────

export function updateSettings(settings: Record<string, string>): void {
  currentSettings = settings;
  // Apply to all existing terminals
  const themeName = settings.theme || "dark";
  const theme = THEMES[themeName] || THEMES.dark;
  const fontSize = parseInt(settings.font_size || "14", 10);
  const fontFamily = FONT_FAMILIES[settings.font_family || "default"] || FONT_FAMILIES.default;
  const scrollback = parseInt(settings.scrollback || "10000", 10);

  for (const entry of pool.values()) {
    entry.terminal.options.fontSize = fontSize;
    entry.terminal.options.fontFamily = fontFamily;
    entry.terminal.options.scrollback = scrollback;
    entry.terminal.options.theme = { ...theme, cursor: entry.terminal.options.theme?.cursor, cursorAccent: theme.background };
    if (entry.attached && entry.opened) {
      try { entry.fitAddon.fit(); } catch { /* ignore */ }
    }
  }
}

// ─── Terminal Lifecycle ──────────────────────────────────────────────

export async function createTerminal(sessionId: string, color: string): Promise<void> {
  if (pool.has(sessionId)) return;

  const themeName = currentSettings.theme || "dark";
  const theme = THEMES[themeName] || THEMES.dark;
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
  terminal.loadAddon(new WebLinksAddon());

  // Wire input → PTY (with intelligence interception)
  terminal.onData((data) => {
    handleTerminalInput(sessionId, data);
  });
  terminal.onBinary((data) => {
    writeToSession(sessionId, btoa(data)).catch((err) => {
      console.warn(`[TerminalPool] write_to_session (binary) failed for ${sessionId}:`, err);
    });
  });

  // Wire PTY output → terminal
  const unlistenOutput = await listen<string>(`pty-output-${sessionId}`, (event) => {
    try {
      const binary = atob(event.payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      terminal.write(bytes);
    } catch {
      terminal.write(event.payload);
    }
  });

  const unlistenExit = await listen(`pty-exit-${sessionId}`, () => {
    terminal.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
  });

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
    // Intelligence
    inputBuffer: "",
    suggestionState: null,
    suggestionTimer: null,
    historyProvider: createHistoryProvider(),
    sessionPhase: "creating",
    cwd: "",
  });
}

// ─── Input Handling & Intelligence ───────────────────────────────────

function handleTerminalInput(sessionId: string, data: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;

  const phase = entry.sessionPhase;
  const intelligenceActive = !isIntelligenceDisabled() &&
    (phase === "idle" || phase === "shell_ready");
  const overlayVisible = entry.suggestionState?.visible ?? false;

  // ── Overlay key interception (only when overlay is showing) ──
  if (intelligenceActive && overlayVisible && entry.suggestionState) {
    // Up arrow
    if (data === "\x1b[A") {
      moveSuggestionSelection(sessionId, -1);
      return; // CONSUME
    }
    // Down arrow
    if (data === "\x1b[B") {
      moveSuggestionSelection(sessionId, 1);
      return; // CONSUME
    }
    // Tab — accept selected (respects shell compatibility)
    if (data === "\t") {
      if (shouldConsumeTab(sessionId, true)) {
        acceptSuggestion(sessionId);
        return; // CONSUME
      }
      // Fall through — let shell handle Tab
    }
    // Enter — execute selected suggestion
    if (data === "\r") {
      executeSuggestion(sessionId);
      return; // CONSUME
    }
    // Escape — dismiss overlay
    if (data === "\x1b" || data === "\x1b\x1b") {
      dismissSuggestions(sessionId);
      return; // CONSUME
    }
    // Right arrow — accept ghost text inline
    if (data === "\x1b[C" && entry.ghostText) {
      acceptGhostInline(sessionId);
      return; // CONSUME
    }
    // Ctrl-Space (explicit invoke) — keep overlay, pass through
    // Any other key: pass to PTY, update buffer, re-query
  }

  // ── Ghost text Tab acceptance (when overlay NOT visible) ──
  if (data === "\t" && entry.ghostText && !overlayVisible) {
    const ghostContent = entry.ghostText;
    clearGhostText(sessionId);
    dismissSuggestions(sessionId);
    writeToSession(sessionId, utf8ToBase64(ghostContent + "\r")).catch((err) => {
      console.warn(`[TerminalPool] write_to_session (ghost accept) failed for ${sessionId}:`, err);
    });
    return;
  }

  // ── Update input buffer ──
  if (intelligenceActive) {
    updateInputBuffer(entry, data);
  }

  // ── Clear ghost text on any non-navigation keystroke ──
  if (entry.ghostText) {
    clearGhostText(sessionId);
  }

  // ── Intent command interception ──
  if (data === "\r" && intelligenceActive && entry.inputBuffer.trimStart().startsWith(":")) {
    const result = resolveIntent(entry.inputBuffer, { cwd: entry.cwd });
    if (result.resolved) {
      const eraseSequence = "\x7f".repeat(entry.inputBuffer.length);
      const fullData = eraseSequence + result.command + "\r";
      entry.historyProvider.addCommand(result.command);
      entry.inputBuffer = "";
      dismissSuggestions(sessionId);
      clearGhostText(sessionId);
      writeToSession(sessionId, utf8ToBase64(fullData)).catch((err) => {
        console.warn(`[TerminalPool] write_to_session (intent) failed:`, err);
      });
      return;
    }
  }

  // ── Always pass data to PTY ──
  writeToSession(sessionId, utf8ToBase64(data)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session failed for ${sessionId}:`, err);
  });

  // ── Debounced suggestion computation ──
  if (intelligenceActive && entry.inputBuffer.trim()) {
    if (entry.suggestionTimer) clearTimeout(entry.suggestionTimer);
    entry.suggestionTimer = setTimeout(() => {
      computeSuggestions(sessionId);
    }, SUGGESTION_DEBOUNCE_MS);
  } else if (intelligenceActive) {
    // Empty buffer — dismiss
    dismissSuggestions(sessionId);
  }
}

function updateInputBuffer(entry: PoolEntry, data: string): void {
  if (data === "\x7f") {
    // Backspace — pop last char
    entry.inputBuffer = entry.inputBuffer.slice(0, -1);
  } else if (data === "\x03") {
    // Ctrl-C — clear
    entry.inputBuffer = "";
    dismissSuggestionsForEntry(entry);
  } else if (data === "\r") {
    // Enter — log to history and clear
    if (entry.inputBuffer.trim()) {
      entry.historyProvider.addCommand(entry.inputBuffer.trim());
    }
    entry.inputBuffer = "";
    dismissSuggestionsForEntry(entry);
  } else if (data === "\x15") {
    // Ctrl-U — clear line
    entry.inputBuffer = "";
    dismissSuggestionsForEntry(entry);
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    // Printable character — append
    entry.inputBuffer += data;
  } else if (data.startsWith("\x1b")) {
    // Escape sequences (arrows, etc.) — don't modify buffer
    // But dismiss suggestions on Escape alone
    if (data === "\x1b") {
      dismissSuggestionsForEntry(entry);
    }
  }
  // Everything else (control chars) — ignore for buffer
}

function computeSuggestions(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry || !entry.inputBuffer.trim()) return;
  if (isIntelligenceDisabled()) return;
  if (!shouldShowOverlay(sessionId)) return;

  // Intent suggestions (colon-prefixed commands)
  if (entry.inputBuffer.trimStart().startsWith(":")) {
    const intentResults = getIntentSuggestions(entry.inputBuffer.trim());
    if (intentResults.length > 0) {
      const pos = getCursorPixelPosition(entry);
      const state: SuggestionState = {
        visible: true,
        suggestions: intentResults.map((r, i) => ({
          text: r.text,
          description: r.description,
          source: "index" as const,
          score: 1000 - i,
          badge: "intent",
        })),
        selectedIndex: 0,
        cursorX: pos.x,
        cursorY: pos.y,
      };
      entry.suggestionState = state;
      notifySubscribers(sessionId, state);
      return;
    }
  }

  const context: ProjectContext | null = entry.cwd ? getCachedContext(entry.cwd) : null;
  const results = suggest(entry.inputBuffer, context, entry.historyProvider);

  if (results.length === 0) {
    dismissSuggestions(sessionId);
    return;
  }

  // Compute cursor position for overlay placement
  const pos = getCursorPixelPosition(entry);

  const state: SuggestionState = {
    visible: true,
    suggestions: results,
    selectedIndex: 0,
    cursorX: pos.x,
    cursorY: pos.y,
  };

  entry.suggestionState = state;
  notifySubscribers(sessionId, state);

  // Show ghost text for top result (if allowed)
  if (shouldShowGhostText(sessionId) && results[0]) {
    const topText = results[0].text;
    const input = entry.inputBuffer.trim();
    // Only show ghost text if it extends the current input
    if (topText.startsWith(input) && topText.length > input.length) {
      showGhostText(sessionId, topText.slice(input.length));
    }
  }
}

// ─── Suggestion Navigation ───────────────────────────────────────────

function moveSuggestionSelection(sessionId: string, delta: number): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;

  const s = entry.suggestionState;
  const count = s.suggestions.length;
  const newIndex = Math.max(0, Math.min(count - 1, s.selectedIndex + delta));

  entry.suggestionState = { ...s, selectedIndex: newIndex };
  notifySubscribers(sessionId, entry.suggestionState);

  // Update ghost text to selected suggestion
  clearGhostText(sessionId);
  const selected = s.suggestions[newIndex];
  if (selected && shouldShowGhostText(sessionId)) {
    const input = entry.inputBuffer.trim();
    if (selected.text.startsWith(input) && selected.text.length > input.length) {
      showGhostText(sessionId, selected.text.slice(input.length));
    }
  }
}

function acceptSuggestion(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;

  const selected = entry.suggestionState.suggestions[entry.suggestionState.selectedIndex];
  if (!selected) return;

  clearGhostText(sessionId);
  dismissSuggestions(sessionId);

  // Erase current input and write the selected command
  const currentInput = entry.inputBuffer;
  entry.inputBuffer = "";

  // Send backspaces to erase current input, then write the suggestion
  const eraseSequence = "\x7f".repeat(currentInput.length);
  const fullData = eraseSequence + selected.text;
  writeToSession(sessionId, utf8ToBase64(fullData)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session (accept) failed for ${sessionId}:`, err);
  });
}

function executeSuggestion(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;

  const selected = entry.suggestionState.suggestions[entry.suggestionState.selectedIndex];
  if (!selected) return;

  // Log to history
  entry.historyProvider.addCommand(selected.text);

  clearGhostText(sessionId);
  dismissSuggestions(sessionId);

  // Erase current input, write suggestion + Enter
  const currentInput = entry.inputBuffer;
  entry.inputBuffer = "";

  const eraseSequence = "\x7f".repeat(currentInput.length);
  const fullData = eraseSequence + selected.text + "\r";
  writeToSession(sessionId, utf8ToBase64(fullData)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session (execute) failed for ${sessionId}:`, err);
  });
}

function acceptGhostInline(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry?.ghostText) return;

  const ghostContent = entry.ghostText;
  clearGhostText(sessionId);
  dismissSuggestions(sessionId);

  entry.inputBuffer += ghostContent;
  writeToSession(sessionId, utf8ToBase64(ghostContent)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session (ghost inline) failed for ${sessionId}:`, err);
  });
}

export function dismissSuggestions(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  dismissSuggestionsForEntry(entry);
  notifySubscribers(sessionId, null);
}

function dismissSuggestionsForEntry(entry: PoolEntry): void {
  if (entry.suggestionTimer) {
    clearTimeout(entry.suggestionTimer);
    entry.suggestionTimer = null;
  }
  entry.suggestionState = null;
}

// ─── Cursor Position Calculation ─────────────────────────────────────

function getCursorPixelPosition(entry: PoolEntry): { x: number; y: number } {
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

function notifySubscribers(sessionId: string, state: SuggestionState | null): void {
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
      // Preserve scroll position at bottom after fit
      entry.terminal.scrollToBottom();
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
  entry.container.style.display = "none";
  entry.attached = false;
}

export function destroy(sessionId: string): void {
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
        entry.terminal.scrollToBottom();
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

// ─── Ghost Text (Command Predictions) ───────────────────────────────

export function showGhostText(sessionId: string, text: string): void {
  const entry = pool.get(sessionId);
  if (!entry || !entry.attached || !entry.opened) return;

  clearGhostText(sessionId);
  entry.ghostText = text;

  // Read actual terminal font settings for accurate sizing
  const opts = entry.terminal.options;
  const fontSize = opts.fontSize || 14;
  const fontFamily = opts.fontFamily || "monospace";
  const lineHeight = opts.lineHeight || 1.2;

  // Create overlay element positioned at cursor
  const overlay = document.createElement("div");
  overlay.className = "ghost-text-overlay";
  overlay.textContent = text;
  overlay.style.cssText = `
    position: absolute;
    color: var(--text-3);
    opacity: 0.4;
    pointer-events: none;
    font-family: ${fontFamily};
    font-size: ${fontSize}px;
    line-height: ${lineHeight};
    white-space: pre;
    z-index: 5;
  `;

  // Position relative to cursor using xterm's internal cell dimensions
  try {
    const term = entry.terminal as any;
    const dims = term._core?._renderService?.dimensions;
    if (dims) {
      const cellW = dims.css?.cell?.width ?? dims.actualCellWidth ?? (fontSize * 0.6);
      const cellH = dims.css?.cell?.height ?? dims.actualCellHeight ?? (fontSize * lineHeight);
      const cursorX = entry.terminal.buffer.active.cursorX;
      const cursorY = entry.terminal.buffer.active.cursorY;
      overlay.style.left = `${cursorX * cellW}px`;
      overlay.style.top = `${cursorY * cellH}px`;
    }
  } catch {
    // Fallback — position at bottom-left
    overlay.style.bottom = "0";
    overlay.style.left = "0";
  }

  // Append to xterm-screen which has the correct coordinate space
  const xtermEl = entry.container.querySelector(".xterm-screen");
  if (xtermEl) {
    (xtermEl as HTMLElement).style.position = "relative";
    xtermEl.appendChild(overlay);
    entry.ghostOverlay = overlay;
  }
}

export function clearGhostText(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;
  entry.ghostText = null;
  if (entry.ghostOverlay) {
    entry.ghostOverlay.remove();
    entry.ghostOverlay = null;
  }
}

export function getTerminal(sessionId: string): Terminal | null {
  return pool.get(sessionId)?.terminal ?? null;
}
