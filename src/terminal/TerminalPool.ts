/**
 * TerminalPool — Main orchestrator.
 *
 * Re-exports the public API from sub-modules:
 *   - themes.ts   — Theme definitions and font configuration
 *   - ghostText.ts — Ghost text overlay rendering
 *   - pool.ts      — Core pool lifecycle (create, destroy, attach, detach)
 *
 * This file contains the input handling & intelligence logic that ties everything together.
 */

import { listen } from "@tauri-apps/api/event";
import { writeToSession } from "../api/sessions";
import { suggest } from "./intelligence/suggestionEngine";
import { resolveIntent, getIntentSuggestions } from "./intentCommands";
import { type ProjectContext, getCachedContext } from "./intelligence/contextAnalyzer";
import { type SuggestionState } from "./intelligence/SuggestionOverlay";
import {
  isIntelligenceDisabled,
  shouldShowGhostText,
  shouldShowOverlay,
  shouldConsumeTab,
} from "./intelligence/shellEnvironment";

import { THEMES, FONT_FAMILIES } from "./themes";
import {
  pool,
  setCurrentSettings,
  createTerminal as createTerminalCore,
  attach,
  detach,
  destroy,
  focusTerminal,
  refitActive,
  has,
  clearTerminal,
  writeScrollback,
  subscribeSuggestions,
  notifySubscribers,
  setSessionPhase,
  setSessionCwd,
  getHistoryProvider,
  detectBranchMismatch,
  showGhostText,
  clearGhostText,
  dismissSuggestions,
  dismissSuggestionsForEntry,
  getCursorPixelPosition,
  getCursorPosition,
  cleanSelection,
  estimateInitialDimensions,
  getFocusedSessionId,
  type PoolEntry,
} from "./pool";

// ─── Helpers ────────────────────────────────────────────────────────

/** UTF-8-safe base64 encoding (handles characters outside Latin-1 range) */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary);
}

const SUGGESTION_DEBOUNCE_MS = 50;

// ─── Settings ────────────────────────────────────────────────────────

export function updateSettings(settings: Record<string, string>): void {
  setCurrentSettings(settings);
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
      try {
        const proposed = entry.fitAddon.proposeDimensions();
        if (proposed && proposed.cols >= 10 && proposed.rows >= 2) {
          entry.fitAddon.fit();
          entry.terminal.refresh(0, entry.terminal.rows - 1);
        }
      } catch { /* ignore */ }
    }
  }
}

// ─── Native SIGINT Listener (macOS) ──────────────────────────────────
//
// On macOS, WKWebView consumes Ctrl+C at the native level before JavaScript
// receives the keydown event. The Rust menu system intercepts it as a menu
// accelerator and emits "native-sigint". We listen here and forward \x03
// to the active terminal's PTY.

let sigintListenerReady = false;

export function setupNativeSigintListener(): void {
  if (sigintListenerReady) return;
  sigintListenerReady = true;
  listen("native-sigint", () => {
    const sessionId = getFocusedSessionId();
    if (!sessionId) return;
    handleTerminalInput(sessionId, "\x03");
  }).catch((err) => {
    console.warn("[TerminalPool] Failed to listen for native-sigint:", err);
    sigintListenerReady = false;
  });
}

// ─── Terminal Creation (wires input handler) ─────────────────────────

export async function createTerminal(sessionId: string, color: string): Promise<void> {
  setupNativeSigintListener(); // idempotent — sets up once
  return createTerminalCore(sessionId, color, handleTerminalInput);
}

// ─── Input Handling & Intelligence ───────────────────────────────────

function handleTerminalInput(sessionId: string, data: string): void {
  const entry = pool.get(sessionId);
  if (!entry) return;

  const phase = entry.sessionPhase;
  const intelligenceActive = !isIntelligenceDisabled() &&
    (phase === "idle" || phase === "shell_ready");
  const overlayVisible = entry.suggestionState?.visible ?? false;

  // ── Dismiss stale overlay when alternate buffer becomes active ──
  // Interactive CLI tools (Claude Code, vim, etc.) switch to the alternate
  // screen buffer. If the overlay was visible when this happened, dismiss it
  // immediately so navigation keys reach the tool instead of the overlay.
  if (overlayVisible && entry.terminal.buffer.active.type === "alternate") {
    dismissSuggestions(sessionId);
    clearGhostText(sessionId);
  }

  // ── Overlay key interception (only when overlay is showing) ──
  // Guard on overlay visibility, NOT intelligenceActive — the phase can
  // briefly flip to "busy" from shell echo while the overlay is still visible.
  // Intelligence gating controls *showing* the overlay; once visible, we
  // must always intercept navigation keys to prevent them reaching the PTY.
  if (overlayVisible && entry.suggestionState) {
    // Up arrow — move selection up (wrapping)
    // Handles both normal mode (\x1b[A) and application cursor mode (\x1bOA)
    if (data === "\x1b[A" || data === "\x1bOA") {
      moveSuggestionSelection(sessionId, -1);
      return; // CONSUME
    }
    // Down arrow — move selection down (wrapping)
    if (data === "\x1b[B" || data === "\x1bOB") {
      moveSuggestionSelection(sessionId, 1);
      return; // CONSUME
    }
    // Tab — accept selected if an item is highlighted (respects shell compatibility)
    if (data === "\t") {
      if (entry.suggestionState.selectedIndex !== null && shouldConsumeTab(sessionId, true)) {
        acceptSuggestion(sessionId);
        return; // CONSUME
      }
      // Nothing highlighted or shell should handle Tab — fall through
    }
    // Enter — accept highlighted suggestion, or pass through if nothing highlighted
    if (data === "\r") {
      if (entry.suggestionState.selectedIndex !== null) {
        executeSuggestion(sessionId);
        return; // CONSUME
      }
      // Nothing highlighted — dismiss overlay and let Enter pass through to PTY
      dismissSuggestions(sessionId);
      clearGhostText(sessionId);
      // Fall through to normal Enter handling (buffer update + PTY write)
    }
    // Escape — dismiss overlay
    if (data === "\x1b" || data === "\x1b\x1b") {
      dismissSuggestions(sessionId);
      return; // CONSUME
    }
    // Ctrl-C — dismiss overlay, then pass through to PTY
    if (data === "\x03") {
      dismissSuggestions(sessionId);
      clearGhostText(sessionId);
      // Fall through — Ctrl-C will be sent to PTY below
    }
    // Right arrow — accept ghost text inline
    if ((data === "\x1b[C" || data === "\x1bOC") && entry.ghostText) {
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
  // Always track input regardless of phase — the buffer must reflect what
  // the user has typed. Only suggestion computation is gated on phase,
  // because every keystroke echo briefly flips phase to "busy".
  updateInputBuffer(entry, data);

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

  // ── Pass data to PTY ──
  writeToSession(sessionId, utf8ToBase64(data)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session failed for ${sessionId}:`, err);
  });

  // ── Debounced suggestion computation ──
  // Always set up the debounce regardless of phase — every keystroke echo
  // briefly flips phase to "busy", which would kill the timer. The actual
  // phase/intelligence check happens inside computeSuggestions().
  if (entry.inputBuffer.trim()) {
    if (entry.suggestionTimer) clearTimeout(entry.suggestionTimer);
    entry.suggestionTimer = setTimeout(() => {
      computeSuggestions(sessionId);
    }, SUGGESTION_DEBOUNCE_MS);
  } else {
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

  // Only show suggestions when the shell is at an interactive prompt.
  // Use lastStablePhase instead of sessionPhase — the current phase can
  // be "busy" from echo-flicker (both shell AND AI agent echo trigger it).
  // lastStablePhase tracks the real state: "idle"/"shell_ready" = shell
  // prompt, "needs_input" = AI agent, "creating"/etc. = lifecycle.
  if (entry.lastStablePhase !== "idle" && entry.lastStablePhase !== "shell_ready") return;

  // Don't show suggestions when the alternate screen buffer is active.
  // Interactive CLI tools (Claude Code, vim, htop, etc.) use the alternate
  // buffer — cursor coordinates in that buffer don't correspond to the shell
  // prompt, and our input buffer tracking doesn't reflect the tool's input.
  if (entry.terminal.buffer.active.type === "alternate") return;

  // Don't show suggestions when the user has scrolled up — the cursor is
  // off-screen and the overlay would appear at a misleading position.
  if (entry.userScrolledUp) return;

  // OS-level foreground process check — uses a cached value updated by a
  // 300ms polling interval (see pool.ts createTerminal). Synchronous access
  // avoids async gaps where state can change between the check and usage.
  // This is the most reliable guard: tcgetpgrp() / /proc/stat tells us
  // whether the shell or a child program (AI tools, editors, etc.) owns
  // the terminal foreground process group.
  if (!entry.shellIsForeground) return;

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
        selectedIndex: null,
        cursorX: pos.x,
        cursorY: pos.y,
        cellHeight: pos.cellHeight,
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
    selectedIndex: null,
    cursorX: pos.x,
    cursorY: pos.y,
    cellHeight: pos.cellHeight,
  };

  entry.suggestionState = state;
  notifySubscribers(sessionId, state);

  // Show ghost text for top result (if allowed)
  if (shouldShowGhostText(sessionId) && results[0]) {
    const topText = results[0].text;
    const input = entry.inputBuffer.trim();
    // Only show ghost text if it extends the current input
    if (topText.startsWith(input) && topText.length > input.length) {
      const ghostSuffix = topText.slice(input.length);
      showGhostText(sessionId, ghostSuffix);
    }
  }
}

// ─── Suggestion Navigation ───────────────────────────────────────────

function moveSuggestionSelection(sessionId: string, delta: number): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;

  const s = entry.suggestionState;
  const count = s.suggestions.length;

  let newIndex: number;
  if (s.selectedIndex === null) {
    // Nothing highlighted yet
    newIndex = delta > 0 ? 0 : count - 1;
  } else {
    // Wrap around at boundaries
    newIndex = ((s.selectedIndex + delta) % count + count) % count;
  }

  entry.suggestionState = { ...s, selectedIndex: newIndex };
  notifySubscribers(sessionId, entry.suggestionState);

  // Update ghost text to preview the highlighted suggestion
  clearGhostText(sessionId);
  const selected = s.suggestions[newIndex];
  if (selected && shouldShowGhostText(sessionId)) {
    const input = entry.inputBuffer.trim();
    if (selected.text.startsWith(input) && selected.text.length > input.length) {
      showGhostText(sessionId, selected.text.slice(input.length));
    }
  }
}

/** Accept a suggestion at a given index (used by click-to-select in the overlay) */
export function acceptSuggestionAtIndex(sessionId: string, index: number): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;

  const s = entry.suggestionState;
  if (index < 0 || index >= s.suggestions.length) return;

  // Set the selected index then delegate to normal accept
  entry.suggestionState = { ...s, selectedIndex: index };
  acceptSuggestion(sessionId);
}

function acceptSuggestion(sessionId: string): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible || entry.suggestionState.selectedIndex === null) return;

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
  if (!entry?.suggestionState?.visible || entry.suggestionState.selectedIndex === null) return;

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

// ─── Public Suggestion Interaction (for mouse clicks) ────────────────

/** Highlight a suggestion by index (e.g. on mouse hover). */
export function selectSuggestion(sessionId: string, index: number): void {
  const entry = pool.get(sessionId);
  if (!entry?.suggestionState?.visible) return;
  const s = entry.suggestionState;
  if (index < 0 || index >= s.suggestions.length) return;

  entry.suggestionState = { ...s, selectedIndex: index };
  notifySubscribers(sessionId, entry.suggestionState);

  // Update ghost text to preview the highlighted suggestion
  clearGhostText(sessionId);
  const selected = s.suggestions[index];
  if (selected && shouldShowGhostText(sessionId)) {
    const input = entry.inputBuffer.trim();
    if (selected.text.startsWith(input) && selected.text.length > input.length) {
      showGhostText(sessionId, selected.text.slice(input.length));
    }
  }
}

// ─── Public Utility Exports ──────────────────────────────────────────

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

export function getTerminal(sessionId: string): import("@xterm/xterm").Terminal | null {
  return pool.get(sessionId)?.terminal ?? null;
}

/** Check if the terminal has an active text selection (canvas-based, not DOM). */
export function terminalHasSelection(sessionId: string): boolean {
  return pool.get(sessionId)?.terminal.hasSelection() ?? false;
}

/** Get the selected text from the terminal (canvas-based selection).
 *  Joins soft-wrapped lines and trims trailing whitespace so copied
 *  text matches the logical content, not the visual terminal layout. */
export function terminalGetSelection(sessionId: string): string {
  const entry = pool.get(sessionId);
  if (!entry) return "";
  const raw = entry.terminal.getSelection();
  if (!raw) return "";
  return cleanSelection(entry.terminal, raw);
}

/** Write arbitrary text into the terminal as if pasted (e.g. a file path from a drop event).
 *  Writes directly to the PTY, bypassing the clipboard entirely. */
export function writeTextToTerminal(sessionId: string, text: string): void {
  const entry = pool.get(sessionId);
  if (!entry || !entry.attached || !entry.opened || !text) return;

  dismissSuggestions(sessionId);
  clearGhostText(sessionId);

  writeToSession(sessionId, utf8ToBase64(text)).catch((err) => {
    console.warn(`[TerminalPool] writeTextToTerminal failed for ${sessionId}:`, err);
  });

  entry.inputBuffer += text;
  focusTerminal(sessionId);
}

/** Insert file paths into the terminal as typed text (e.g. from OS file drop).
 *  Paths with spaces are quoted. Multiple paths are space-separated. */
export function insertFilePaths(sessionId: string, paths: string[]): void {
  const entry = pool.get(sessionId);
  if (!entry || paths.length === 0) return;

  const formatted = paths
    .map((p) => (p.includes(" ") ? `"${p}"` : p))
    .join(" ");

  // Append a trailing space so the user can keep typing / drop more files
  const text = formatted + " ";

  dismissSuggestions(sessionId);
  clearGhostText(sessionId);

  // Write through the PTY so the shell sees it as pasted input
  writeToSession(sessionId, utf8ToBase64(text)).catch((err) => {
    console.warn(`[TerminalPool] write_to_session (file drop) failed for ${sessionId}:`, err);
  });

  // Update input buffer to keep suggestion engine in sync
  entry.inputBuffer += text;

  focusTerminal(sessionId);
}

// ─── Re-exports from sub-modules ─────────────────────────────────────
// Maintain backward compatibility — all consumers import from TerminalPool.ts

export {
  // pool.ts — core lifecycle
  attach,
  detach,
  destroy,
  focusTerminal,
  refitActive,
  has,
  clearTerminal,
  writeScrollback,
  subscribeSuggestions,
  setSessionPhase,
  setSessionCwd,
  getHistoryProvider,
  detectBranchMismatch,
  showGhostText,
  clearGhostText,
  dismissSuggestions,
  getCursorPosition,
  estimateInitialDimensions,
};
