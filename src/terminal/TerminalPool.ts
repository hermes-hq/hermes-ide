import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { isMac } from "../utils/platform";
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
  userScrolledUp: boolean;
  // Intelligence state
  inputBuffer: string;
  suggestionState: SuggestionState | null;
  suggestionTimer: ReturnType<typeof setTimeout> | null;
  historyProvider: HistoryProvider;
  sessionPhase: string;
  cwd: string;
  // Dedup: rolling window of recently-sent printable chars (prevents WKWebView
  // composition flush from re-sending the entire textarea content)
  sentChars: string;
}

type SuggestionCallback = (state: SuggestionState | null) => void;

// ─── State ───────────────────────────────────────────────────────────

const pool = new Map<string, PoolEntry>();
const suggestionSubscribers = new Map<string, Set<SuggestionCallback>>();
/** Guard set: sessionIds currently being created (between pool.has check and pool.set) */
const creating = new Set<string>();

const SUGGESTION_DEBOUNCE_MS = 50;

// Dedup: maximum size for the per-session sent-chars buffer. Characters older
// than this window are dropped.  The buffer is also cleared on Enter/Ctrl-C.
const SENT_CHARS_MAX = 512;

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
  hacker: {
    background: "#0a0a0a",
    foreground: "#29cc7a",
    selectionBackground: "#33ff9933",
    selectionForeground: "#ffffff",
    cursor: "#33ff99",
    black: "#0a0a0a", red: "#ff4444", green: "#33ff99", yellow: "#ccff00",
    blue: "#33cc88", magenta: "#66ffbb", cyan: "#00cc88", white: "#29cc7a",
    brightBlack: "#0f5030", brightRed: "#ff6666", brightGreen: "#66ffcc",
    brightYellow: "#ddff44", brightBlue: "#55ddaa", brightMagenta: "#88ffcc",
    brightCyan: "#33ddaa", brightWhite: "#33ff99",
  },
  designer: {
    background: "#1a1714",
    foreground: "#c8bfb0",
    selectionBackground: "#e0785033",
    selectionForeground: "#ffffff",
    cursor: "#e07850",
    black: "#1a1714", red: "#d95555", green: "#8fbc6a", yellow: "#d4a845",
    blue: "#7a9ec2", magenta: "#b58bdb", cyan: "#6bbfb0", white: "#c8bfb0",
    brightBlack: "#6b6258", brightRed: "#e07070", brightGreen: "#a5d280",
    brightYellow: "#e0be5a", brightBlue: "#90b4d8", brightMagenta: "#cba0f0",
    brightCyan: "#80d5c6", brightWhite: "#e8e0d4",
  },
  data: {
    background: "#0a0e1a",
    foreground: "#9aacc8",
    selectionBackground: "#22d3ee33",
    selectionForeground: "#ffffff",
    cursor: "#22d3ee",
    black: "#0a0e1a", red: "#f87171", green: "#34d399", yellow: "#fbbf24",
    blue: "#60a5fa", magenta: "#818cf8", cyan: "#22d3ee", white: "#9aacc8",
    brightBlack: "#3a4a68", brightRed: "#fca5a5", brightGreen: "#6ee7b7",
    brightYellow: "#fcd34d", brightBlue: "#93c5fd", brightMagenta: "#a5b4fc",
    brightCyan: "#67e8f9", brightWhite: "#c8d8f0",
  },
  corporate: {
    background: "#111418",
    foreground: "#aab0bc",
    selectionBackground: "#4a90d933",
    selectionForeground: "#ffffff",
    cursor: "#4a90d9",
    black: "#111418", red: "#ef5350", green: "#48c78e", yellow: "#f0ad4e",
    blue: "#4a90d9", magenta: "#7c8aed", cyan: "#56c8d8", white: "#aab0bc",
    brightBlack: "#4a5060", brightRed: "#f48382", brightGreen: "#70daa8",
    brightYellow: "#f5c473", brightBlue: "#74aae3", brightMagenta: "#9da8f2",
    brightCyan: "#78d8e6", brightWhite: "#d4d8e0",
  },
  nightowl: {
    background: "#010104",
    foreground: "#a8a8c8",
    selectionBackground: "#a78bfa33",
    selectionForeground: "#ffffff",
    cursor: "#a78bfa",
    black: "#010104", red: "#ff6b6b", green: "#66e0a3", yellow: "#ffd166",
    blue: "#7aa2f7", magenta: "#a78bfa", cyan: "#7dcfff", white: "#a8a8c8",
    brightBlack: "#3a3a5a", brightRed: "#ff9090", brightGreen: "#8aeabb",
    brightYellow: "#ffe088", brightBlue: "#9dbcfc", brightMagenta: "#c4b5fd",
    brightCyan: "#a0dfff", brightWhite: "#d6d6f0",
  },
  tron: {
    background: "#030810",
    foreground: "#8ecae6",
    selectionBackground: "#00dffc33",
    selectionForeground: "#ffffff",
    cursor: "#00dffc",
    black: "#030810", red: "#ff3855", green: "#00ffaa", yellow: "#ffe64d",
    blue: "#00dffc", magenta: "#7df9ff", cyan: "#00dffc", white: "#8ecae6",
    brightBlack: "#1e5070", brightRed: "#ff6680", brightGreen: "#44ffbb",
    brightYellow: "#ffed77", brightBlue: "#44e8ff", brightMagenta: "#a0fcff",
    brightCyan: "#44e8ff", brightWhite: "#d0f0ff",
  },
  rainbow: {
    background: "#0a0612",
    foreground: "#c0bcd0",
    selectionBackground: "#d6a0ff33",
    selectionForeground: "#ffffff",
    cursor: "#d6a0ff",
    black: "#08080e", red: "#ff5577", green: "#44dd88", yellow: "#ffcc44",
    blue: "#44aaff", magenta: "#aa77ff", cyan: "#55ccdd", white: "#c0bcd0",
    brightBlack: "#44405a", brightRed: "#ff7799", brightGreen: "#66eeaa",
    brightYellow: "#ffdd66", brightBlue: "#66bbff", brightMagenta: "#cc99ff",
    brightCyan: "#77ddee", brightWhite: "#eae8f0",
  },
  duel: {
    background: "#06060a",
    foreground: "#b0aac0",
    selectionBackground: "#b0b0c833",
    selectionForeground: "#ffffff",
    cursor: "#b0b0c8",
    black: "#06060a", red: "#ee4444", green: "#44ee88", yellow: "#f0c040",
    blue: "#6688cc", magenta: "#aa66dd", cyan: "#55bbcc", white: "#b0aac0",
    brightBlack: "#3e3a50", brightRed: "#ff6666", brightGreen: "#77ffaa",
    brightYellow: "#f5d466", brightBlue: "#88aadd", brightMagenta: "#cc88ee",
    brightCyan: "#77ccdd", brightWhite: "#e0dce8",
  },
  "80s": {
    background: "#0a0800",
    foreground: "#cc8c00",
    selectionBackground: "#ffb00033",
    selectionForeground: "#ffb000",
    cursor: "#ffb000",
    black: "#0a0800", red: "#ff3333", green: "#33ff33", yellow: "#ffcc00",
    blue: "#ffb000", magenta: "#ff6600", cyan: "#cc8c00", white: "#cc8c00",
    brightBlack: "#554000", brightRed: "#ff6644", brightGreen: "#66ff66",
    brightYellow: "#ffdd44", brightBlue: "#ffc033", brightMagenta: "#ff8833",
    brightCyan: "#ddaa33", brightWhite: "#ffb000",
  },
  solarized: {
    background: "#fdf6e3",
    foreground: "#586e75",
    selectionBackground: "#268bd233",
    selectionForeground: "#073642",
    cursor: "#268bd2",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#6c71c4", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#859900",
    brightYellow: "#b58900", brightBlue: "#268bd2", brightMagenta: "#6c71c4",
    brightCyan: "#2aa198", brightWhite: "#fdf6e3",
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
  const themeName = settings.theme || "tron";
  const theme = THEMES[themeName] || THEMES.tron;
  const fontSize = parseInt(settings.font_size || "14", 10);
  const fontFamily = FONT_FAMILIES[settings.font_family || "default"] || FONT_FAMILIES.default;
  const scrollback = parseInt(settings.scrollback || "10000", 10);

  for (const [sessionId, entry] of pool) {
    // Clear ghost overlays before font/size changes (they'd be misaligned)
    clearGhostText(sessionId);
    entry.terminal.options.fontSize = fontSize;
    entry.terminal.options.fontFamily = fontFamily;
    entry.terminal.options.scrollback = scrollback;
    entry.terminal.options.theme = { ...theme, cursor: entry.terminal.options.theme?.cursor, cursorAccent: theme.background };
    if (entry.attached && entry.opened) {
      try { entry.fitAddon.fit(); } catch { /* ignore */ }
    }
  }
}

// ─── Keydown Passthrough Allowlist ────────────────────────────────────
// Keys that MUST go through the keydown → onData path. Everything NOT in
// this set is suppressed at keydown (textarea input is the sole source).
// This handles dead keys ("Dead", length > 1) which the old
// key-length-based check failed to suppress.
const KEYDOWN_PASSTHROUGH = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "Insert", "Clear", "Pause", "ScrollLock", "PrintScreen",
  "CapsLock", "NumLock",
]);

// ─── Terminal Lifecycle ──────────────────────────────────────────────

export async function createTerminal(sessionId: string, color: string): Promise<void> {
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
  // ── Composition state for dead key handling (macOS WKWebView only) ──
  // WKWebView dead key flow:
  //   1. compositionend fires with composed char (e.g. "'")
  //   2. xterm fires onData("'") — legitimate, first occurrence
  //   3. keydown fires for the RESOLVING key (e.g. "t") — normally suppressed
  //   4. Composition's textarea input fires — xterm fires onData("'") AGAIN (duplicate)
  //   5. The textarea input for "t" fires but produces NO onData (xterm already consumed it)
  //
  // Fixes needed:
  //   A. Suppress the duplicate onData for the composed char (step 4)
  //   B. Allow the resolving keydown through (step 3) since textarea path is broken (step 5)
  //   C. Dedup the resolving char in case the textarea path does fire for it
  let lastComposedChar: string | null = null;
  let composedDataFired = false;
  let postCompPassOne = false;     // Allow ONE keydown through after composition
  let postCompChar: string | null = null; // The resolving character to dedup
  let postCompCharFired = false;

  if (isMac) {
    container.addEventListener("compositionend", (e: CompositionEvent) => {
      lastComposedChar = e.data || null;
      composedDataFired = false;
      postCompPassOne = true;
      postCompChar = null;
      postCompCharFired = false;
      // Safety timeout: clear all composition state
      setTimeout(() => {
        lastComposedChar = null;
        composedDataFired = false;
        postCompPassOne = false;
        postCompChar = null;
        postCompCharFired = false;
      }, 200);
    }, true); // capture phase — fires BEFORE xterm's bubbling-phase handler
  }

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Only intercept keydown — keyup is harmless
    if (event.type !== "keydown") return true;

    // After compositionend, the resolving character (e.g. "t" after dead key
    // apostrophe) is LOST because:
    // - xterm ignores keydown during/after composition
    // - The textarea path is broken (composition's deferred input consumed it)
    //
    // CRITICAL: On WKWebView, event.key for the resolving keydown is the
    // composed char + resolving char CONCATENATED (e.g. "'t" not "t").
    // We must extract the resolving character from after the composed prefix.
    //
    // Cases:
    //   Non-combining: ' + t → composedChar="'", event.key="'t" → resolve "t" ✓
    //   Combining:     ' + a → composedChar="á", event.key="á"  → no resolve  ✓
    //   Space resolve: ' + space → composedChar="'", event.key="' " → skip    ✓
    if (postCompPassOne && !event.ctrlKey && !event.metaKey && !event.altKey) {
      postCompPassOne = false;

      // Extract resolving character: only for non-combining dead key results
      // where event.key starts with the composed char and has additional chars.
      let resolving: string | null = null;
      if (lastComposedChar &&
          event.key.startsWith(lastComposedChar) &&
          event.key.length > lastComposedChar.length) {
        resolving = event.key.slice(lastComposedChar.length);
        // Don't inject space — it's a transparent dead key resolver
        if (!resolving.trim()) resolving = null;
      } else if (event.key.length === 1) {
        // Fallback: single-char key (normal behavior)
        resolving = event.key;
      }

      if (resolving) {
        postCompChar = resolving;
        postCompCharFired = true; // Mark as already fired — prevents textarea duplicate

        // Inject directly — bypass xterm's composition state
        handleTerminalInput(sessionId, resolving);
        return false; // SUPPRESS xterm's keydown
      }
      // Combining case or space resolver — fall through to normal handling
    }

    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);

    if (shouldSuppress) return false;

    // Allow composing (IME) — textarea handles the final composed char
    if (event.isComposing) return true;
    // Allow modifier combos (Ctrl-C, Cmd-V, Alt-anything)
    if (event.ctrlKey || event.metaKey || event.altKey) return true;
    // Allow non-printable keys
    return true;
  });

  terminal.onData((data) => {
    // ── Composition dedup: suppress duplicate composed char from textarea input ──
    // IMPORTANT: Do NOT clear lastComposedChar on non-matching data!
    // The resolving key's onData (e.g. "t") fires BETWEEN the first and duplicate
    // "'" events. Clearing state on "t" would let the duplicate "'" pass through.
    // The compositionend listener's 200ms timeout handles cleanup.
    if (lastComposedChar !== null && data === lastComposedChar) {
      if (composedDataFired) {
        return;
      }
      composedDataFired = true;
    }

    // ── Post-composition dedup: suppress duplicate resolving char ──
    // The resolving key (e.g. "t") was allowed through keydown. If the textarea
    // path also fires for it, suppress the duplicate.
    // Same rule: do NOT clear on non-matching data — timeout handles cleanup.
    if (postCompChar !== null && data === postCompChar) {
      if (postCompCharFired) {
        return;
      }
      postCompCharFired = true;
    }

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
    sentChars: "",
  });
  creating.delete(sessionId);
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
    entry.sentChars = ""; // Reset — ghost accept changes the prompt line
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
      entry.sentChars = "";
      dismissSuggestions(sessionId);
      clearGhostText(sessionId);
      writeToSession(sessionId, utf8ToBase64(fullData)).catch((err) => {
        console.warn(`[TerminalPool] write_to_session (intent) failed:`, err);
      });
      return;
    }
  }

  // ── Dedup guard: WKWebView composition flush ──
  // xterm's hidden textarea accumulates typed characters (never cleared during
  // normal typing).  Under heavy terminal.write() output, WKWebView can fire
  // spurious compositionstart/compositionend events.  The compositionend handler
  // reads the *entire* accumulated textarea value and sends it via onData,
  // duplicating characters that were already sent individually.
  //
  // Guard: if a multi-char, non-escape, non-paste payload is a contiguous
  // substring of the recently-sent character window, suppress it.
  if (data.length > 4) {
    const isEscapeSeq = data.charCodeAt(0) === 0x1b;
    const isBracketedPaste = data.includes("\x1b[200~");
    if (!isEscapeSeq && !isBracketedPaste && entry.sentChars.length >= data.length) {
      // Extract only printable chars for comparison
      let printable = "";
      for (let i = 0; i < data.length; i++) {
        if (data.charCodeAt(i) >= 32) printable += data[i];
      }
      if (printable.length > 4 && entry.sentChars.includes(printable)) {
        return; // Suppress — this is a duplicate composition flush
      }
    }
  }

  // ── Always pass data to PTY ──
  writeToSession(sessionId, utf8ToBase64(data)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session failed for ${sessionId}:`, err);
  });

  // ── Track sent characters for dedup ──
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x0d || code === 0x03) {
      // Enter or Ctrl-C: reset sent window (new prompt line)
      entry.sentChars = "";
    } else if (code >= 32) {
      entry.sentChars += data[i];
      if (entry.sentChars.length > SENT_CHARS_MAX) {
        entry.sentChars = entry.sentChars.slice(-SENT_CHARS_MAX);
      }
    }
  }

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

/** Remove the last Unicode code point from the buffer (surrogate-pair safe) */
function sliceLastCodePoint(buf: string): string {
  if (buf.length === 0) return buf;
  // Check if the last two code units form a surrogate pair
  if (buf.length >= 2) {
    const last = buf.charCodeAt(buf.length - 1);
    const prev = buf.charCodeAt(buf.length - 2);
    if (last >= 0xDC00 && last <= 0xDFFF && prev >= 0xD800 && prev <= 0xDBFF) {
      return buf.slice(0, -2);
    }
  }
  return buf.slice(0, -1);
}

function updateInputBuffer(entry: PoolEntry, data: string): void {
  // Single-char fast paths (keyboard input — one char per onData call)
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code === 0x7f) {
      // Backspace — surrogate-pair safe
      entry.inputBuffer = sliceLastCodePoint(entry.inputBuffer);
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C or Ctrl-U — clear
      entry.inputBuffer = "";
      dismissSuggestionsForEntry(entry);
    } else if (code === 0x0d) {
      // Enter — log to history and clear
      if (entry.inputBuffer.trim()) {
        entry.historyProvider.addCommand(entry.inputBuffer.trim());
      }
      entry.inputBuffer = "";
      dismissSuggestionsForEntry(entry);
    } else if (code === 0x1b) {
      // Bare Escape — dismiss suggestions
      dismissSuggestionsForEntry(entry);
    } else if (code >= 32) {
      // Single printable character
      entry.inputBuffer += data;
    }
    return;
  }

  // Escape sequences (arrows, etc.) — don't modify buffer
  if (data.startsWith("\x1b")) return;

  // Multi-char data (paste, IME, shortcut paste payload).
  // Process EVERY character — control chars have their normal effect.
  // This is critical: paste data like "\x15/config\r" must clear the buffer
  // on \x15, add "/config", then clear again on \r.
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x7f) {
      // Backspace within paste — surrogate-pair safe
      entry.inputBuffer = sliceLastCodePoint(entry.inputBuffer);
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C or Ctrl-U within paste — clear buffer
      entry.inputBuffer = "";
      dismissSuggestionsForEntry(entry);
    } else if (code === 0x0d) {
      // Enter within paste — log to history and clear
      if (entry.inputBuffer.trim()) {
        entry.historyProvider.addCommand(entry.inputBuffer.trim());
      }
      entry.inputBuffer = "";
      dismissSuggestionsForEntry(entry);
    } else if (code === 0x1b) {
      // Escape sequence embedded in paste — skip the sequence, keep processing
      // Escape sequences: \x1b[ followed by params and a letter terminator
      if (i + 1 < data.length && data[i + 1] === "[") {
        // CSI sequence: skip until letter terminator (@ through ~)
        i += 2; // skip \x1b[
        while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) {
          i++;
        }
        // i now points at the terminator — loop increment will advance past it
      } else if (i + 1 < data.length) {
        // Two-char sequence (e.g., \x1bO) — skip one char
        i++;
      }
      // Single bare escape — just skip it
    } else if (code >= 32) {
      // Printable character
      entry.inputBuffer += data[i];
    }
    // All other control chars (code < 32) are silently skipped
  }
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

  // Send backspaces to erase current input, then write the suggestion
  const eraseSequence = "\x7f".repeat(currentInput.length);
  const fullData = eraseSequence + selected.text;

  // Update inputBuffer to the accepted text (writeToSession bypasses onData,
  // so the buffer must be set explicitly to stay in sync)
  entry.inputBuffer = selected.text;

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
    entry.sentChars = "";
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

/** Get the current inputBuffer length for a session (for erasing existing input). */
export function getInputBufferLength(sessionId: string): number {
  return pool.get(sessionId)?.inputBuffer.length ?? 0;
}

/** Clear the inputBuffer for a session (e.g. after composed prompt replaces all input). */
export function clearInputBuffer(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (entry) entry.inputBuffer = "";
}

/** Insert a shortcut command text on the current prompt line.
 *
 *  Replaces any existing input with the command text. Does NOT press Enter —
 *  the user can review/edit the command and press Enter manually.
 *
 *  Uses xterm's internal triggerDataEvent with isPaste=false so the data is
 *  treated as normal keyboard input (no bracketed paste markers).
 *
 *  Invariants enforced:
 *  - command NEVER contains \n or \r (caller must ensure)
 */
export function sendShortcutCommand(sessionId: string, command: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;

  // Invariant: command must not contain line breaks
  if (command.includes("\n") || command.includes("\r")) {
    return;
  }

  // Save input buffer length BEFORE clearing — we need it for backspaces
  const eraseLen = entry.inputBuffer.length;
  entry.inputBuffer = "";
  dismissSuggestions(sessionId);
  clearGhostText(sessionId);

  // Send backspaces (to clear existing text) + command text.
  // NO \r — the command is inserted on the prompt, not executed.
  // The user reviews and presses Enter manually.
  const backspaces = eraseLen > 0 ? "\x7f".repeat(eraseLen) : "";
  const fullData = backspaces + command;
  const core = (entry.terminal as any)._core;
  if (core?.coreService?.triggerDataEvent) {
    core.coreService.triggerDataEvent(fullData, false);
  } else {
    writeToSession(sessionId, utf8ToBase64(fullData)).catch((err) => {
      console.warn(`[TerminalPool] write_to_session (shortcut) failed for ${sessionId}:`, err);
    });
  }

  // Refocus terminal — clicking the shortcut button steals focus from xterm.
  focusTerminal(sessionId);
}

export function getTerminal(sessionId: string): Terminal | null {
  return pool.get(sessionId)?.terminal ?? null;
}

/** Check if the terminal has an active text selection (canvas-based, not DOM). */
export function terminalHasSelection(sessionId: string): boolean {
  return pool.get(sessionId)?.terminal.hasSelection() ?? false;
}

/** Get the selected text from the terminal (canvas-based selection). */
export function terminalGetSelection(sessionId: string): string {
  return pool.get(sessionId)?.terminal.getSelection() ?? "";
}
