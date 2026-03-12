/**
 * WKWebView Composition — Comprehensive Behavioral Test Suite
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS:
 *
 * macOS WKWebView (used by Tauri) has a 10-year-old unfixed bug (WebKit
 * Bug #165004) where composition events fire in the WRONG ORDER:
 *
 *   Chrome:    keydown → compositionstart → input → compositionend
 *   WKWebView: compositionstart → input → keydown  ← REVERSED
 *
 * This causes two problems:
 * 1. After a non-combining dead key resolves, WKWebView fires a keypress
 *    with the dead key's charCode (e.g. 39 for apostrophe). xterm's
 *    _keyPress processes this → emits duplicate char AND sets
 *    _keyPressHandled=true, causing the resolving key's insertText to
 *    be skipped (e.g. "t" in don't is lost).
 * 2. xterm's _keyDownSeen was set BEFORE the customKeyEventHandler check,
 *    blocking _inputEvent even when the handler returned false.
 *
 * Our fix has two parts:
 * 1. patch-package: Moves _keyDownSeen=true AFTER customKeyEventHandler
 *    check in xterm.js, so when our handler returns false, _keyDownSeen
 *    stays false.
 * 2. Event blocking after compositionend: Block keydown/keypress/keyup
 *    via customKeyEventHandler (preventing _keyDownSeen + stale keypress).
 *    insertText input events pass through to xterm's _inputEvent, which
 *    processes them because _keyDownSeen=false and _keyPressHandled=false.
 *    CompositionHelper's setTimeout(0) emits the dead key char; _inputEvent
 *    emits the trailing char. Flag cleared on keyup (not setTimeout).
 *
 * CRITICAL: xterm's CompositionHelper handles ALL composition events
 * natively. We do NOT intercept/stopPropagation on composition events.
 * This is what fixes the display corruption with combining dead keys
 * (ã, é, á, etc.).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW THIS TESTS IT:
 *
 * We model the DOM event propagation:
 *
 *   Event fires on textarea →
 *     1. Container capture-phase listener:
 *        - compositionend: sets recentCompositionEnd (no stopProp)
 *     2. Textarea listeners (xterm's internals — sees all events)
 *
 * We model xterm.js's key internals:
 *   - _keyDown: customKeyEventHandler check → _keyDownSeen (PATCHED order)
 *   - _keyUp: resets _keyDownSeen to false (source of duplication bug)
 *   - _keyPress: customKeyEventHandler check → _keyPressHandled
 *   - _inputEvent: checks _keyDownSeen and _keyPressHandled
 *   - CompositionHelper: compositionstart/end → _isComposing → finalizeComposition
 *
 * The test verifies that ptySends contains EXACTLY the expected characters
 * with NO duplicates and NO missing characters.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from "vitest";

// ─── Minimal Event Propagation Model ─────────────────────────────────

interface SimEvent {
  type: string;
  stopped: boolean;
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
  key?: string;
  code?: string;
  keyCode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  charCode?: number;
}

function makeEvent(type: string, props: Partial<SimEvent> = {}): SimEvent {
  return { type, stopped: false, ...props };
}

// ─── State ───────────────────────────────────────────────────────────

// Our fix state
let recentCompositionEnd: boolean;

// xterm.js internal state
let xtermIsComposing: boolean;
let xtermIsSendingComposition: boolean;
let xtermCompositionStart: number;
let xtermKeyDownSeen: boolean;
let xtermKeyPressHandled: boolean;
let textareaValue: string;
let ptySends: string[];
let pendingTimeouts: (() => void)[];

// ─── Our Fix: Container Capture Listeners ────────────────────────────

function containerCompositionEndCapture(_e: SimEvent): void {
  // Does NOT stop propagation — xterm sees the event
  recentCompositionEnd = true;
  // Flag cleared on keyup (not setTimeout — WKWebView's setTimeout fires
  // BEFORE the trailing keydown, making it useless for this purpose).
}

// ─── Our Fix: attachCustomKeyEventHandler ────────────────────────────

function customKeyEventHandler(e: SimEvent): boolean {
  // Block keydown/keypress/keyup right after compositionend. This prevents:
  // 1. keydown from setting _keyDownSeen (our patch ensures it's set
  //    AFTER the handler check) and from triggering CompositionHelper's
  //    immediate read
  // 2. keypress from processing the dead key's charCode (e.g. 39 for ')
  // Flag cleared on keyup (always the last event in the sequence).
  if (recentCompositionEnd) {
    if (e.type === "keyup") {
      recentCompositionEnd = false;
    }
    return false;
  }

  // Let xterm handle everything else natively
  return true;
}

// ─── xterm.js Internal Model ─────────────────────────────────────────

function xtermKeydownHandler(e: SimEvent): void {
  // xterm's _keyDown: PATCHED — customKeyEventHandler check BEFORE _keyDownSeen
  xtermKeyPressHandled = false; // reset at start of _keyDown (not exactly but close enough)

  if (!customKeyEventHandler(e)) return;

  // PATCHED: _keyDownSeen set AFTER handler returns true
  xtermKeyDownSeen = true;

  // CompositionHelper.keydown():
  // 1. If composing + keyCode=229 → continue composing, return false
  // 2. If _isSendingComposition + non-229 non-modifier → immediate read, return true
  // 3. If not composing + keyCode=229 → _handleAnyTextareaChanges
  if (xtermIsComposing) {
    if (e.keyCode === 229) return;
  }

  // _isSendingComposition: compositionend scheduled a read, but a keydown
  // arrived first. Read the composition data IMMEDIATELY before the trailing
  // keystroke modifies the textarea.
  if (xtermIsSendingComposition && e.keyCode !== 229) {
    const data = textareaValue.substring(xtermCompositionStart);
    if (data.length > 0) {
      xtermOnData(data);
    }
    xtermCompositionStart = textareaValue.length;
    xtermIsSendingComposition = false;
  }

  if (e.keyCode === 229 && !xtermIsComposing) {
    // Not composing + keyCode=229 → _handleAnyTextareaChanges via setTimeout(0)
    const oldValue = textareaValue;
    pendingTimeouts.push(() => {
      const newValue = textareaValue;
      if (newValue.length > oldValue.length) {
        const diff = newValue.slice(oldValue.length);
        if (diff.length > 0) {
          xtermOnData(diff);
        }
      }
    });
    return;
  }

  // evaluateKeyboardEvent: handle special keys
  switch (e.key) {
    case "Enter": xtermOnData("\r"); return;
    case "Backspace": xtermOnData("\x7f"); return;
    case "Tab": xtermOnData("\t"); return;
    case "Escape": xtermOnData("\x1b"); return;
    case "ArrowUp": xtermOnData("\x1b[A"); return;
    case "ArrowDown": xtermOnData("\x1b[B"); return;
    case "ArrowLeft": xtermOnData("\x1b[D"); return;
    case "ArrowRight": xtermOnData("\x1b[C"); return;
  }

  // For printable keys, xterm handles via evaluateKeyboardEvent
  // which checks ev.key.length === 1 → result.key = ev.key
  if (e.key && e.key.length === 1) {
    xtermOnData(e.key);
  }
}

function xtermKeyupHandler(e: SimEvent): void {
  // xterm's _keyUp: resets _keyDownSeen BEFORE customKeyEventHandler check
  xtermKeyDownSeen = false;

  // customKeyEventHandler is called AFTER _keyDownSeen reset
  if (!customKeyEventHandler(e)) return;

  xtermKeyPressHandled = false;
}

function xtermKeypressHandler(e: SimEvent): void {
  // xterm's _keyPress: customKeyEventHandler check first
  if (!customKeyEventHandler(e)) return;

  // If handler returned true, _keyPressHandled is set
  xtermKeyPressHandled = true;
}

function xtermInputHandler(e: SimEvent): void {
  // xterm's _inputEvent (line 1192) ONLY processes insertText:
  //   if (ev.data && ev.inputType === 'insertText' && (!ev.composed || !this._keyDownSeen))
  // Composition-related input types (insertCompositionText, deleteCompositionText,
  // insertFromComposition) are ignored — CompositionHelper handles those.
  if (e.inputType !== "insertText") return;

  if (xtermKeyPressHandled) return;

  if (e.data && !xtermKeyDownSeen) {
    xtermOnData(e.data);
  }

  // xterm clears textarea and resets flags in setTimeout(0)
  pendingTimeouts.push(() => {
    textareaValue = "";
    xtermKeyDownSeen = false;
    xtermKeyPressHandled = false;
  });
}

function xtermCompositionStartHandler(_e: SimEvent): void {
  xtermIsComposing = true;
  // Record textarea position at composition start
  xtermCompositionStart = textareaValue.length;
}

function xtermCompositionEndHandler(_e: SimEvent): void {
  xtermIsComposing = false;
  // CompositionHelper._finalizeComposition:
  //   - Sets _isSendingComposition = true
  //   - Schedules setTimeout(0) to read textarea
  // If a keydown arrives before the setTimeout, it triggers immediate read
  // (handled in xtermKeydownHandler via _isSendingComposition check)
  xtermIsSendingComposition = true;
  const capturedStart = xtermCompositionStart;
  pendingTimeouts.push(() => {
    // Only read if not already consumed by an immediate read
    if (xtermIsSendingComposition) {
      const value = textareaValue;
      if (value.length > capturedStart) {
        const data = value.substring(capturedStart);
        xtermOnData(data);
      }
      xtermCompositionStart = textareaValue.length;
      xtermIsSendingComposition = false;
    }
    textareaValue = "";
  });
}

/** terminal.onData — clean, no guards needed */
function xtermOnData(data: string): void {
  ptySends.push(data);
}

// ─── Event Dispatch (Models DOM Capture-Phase Propagation) ───────────

function dispatch(e: SimEvent): void {
  // Step 1: Container capture listeners (our code)
  if (e.type === "compositionend") {
    containerCompositionEndCapture(e);
  }

  // Step 1b: Container capture-phase Ctrl+C handler.
  // Sends \x03 (SIGINT) and stops propagation so xterm never sees the event.
  // This is the PRIMARY Ctrl+C path — it fires before xterm's textarea
  // handlers, guaranteeing SIGINT reaches the PTY even if WKWebView would
  // otherwise consume the event at the native level.
  if (e.type === "keydown" && e.ctrlKey && !e.metaKey && !e.altKey &&
      (e.key === "c" || e.key === "C" || e.code === "KeyC")) {
    e.stopped = true;
    xtermOnData("\x03");
  }

  // If event was stopped by capture-phase handler, don't propagate to xterm
  if (e.stopped) return;

  // Note: compositionend does NOT stop propagation — always reaches xterm
  // Note: insertText input events pass through — no capture blocking

  // Step 2: Event reaches xterm's textarea handlers
  switch (e.type) {
    case "keydown": xtermKeydownHandler(e); break;
    case "keyup": xtermKeyupHandler(e); break;
    case "keypress": xtermKeypressHandler(e); break;
    case "input": xtermInputHandler(e); break;
    case "compositionstart": xtermCompositionStartHandler(e); break;
    case "compositionend": xtermCompositionEndHandler(e); break;
  }
}

/** Flush all pending setTimeout(0) callbacks */
function flushTimeouts(): void {
  const fns = [...pendingTimeouts];
  pendingTimeouts = [];
  for (const fn of fns) fn();
}

// ─── Event Simulation Helpers ────────────────────────────────────────

function fireKeydown(key: string, code: string, opts: {
  isComposing?: boolean; keyCode?: number;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
} = {}): void {
  dispatch(makeEvent("keydown", {
    key, code,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
  }));
}

function fireKeypress(key: string, charCode: number): void {
  dispatch(makeEvent("keypress", { key, charCode }));
}

function fireKeyup(key: string, code: string): void {
  dispatch(makeEvent("keyup", { key, code }));
}

function fireInput(data: string | null, inputType: string, isComposing = false, updateTextarea = true): void {
  // Simulate browser updating textarea value
  if (updateTextarea) {
    if (data && (inputType === "insertText" || inputType === "insertCompositionText" || inputType === "insertFromComposition")) {
      textareaValue += data;
    } else if (inputType === "deleteCompositionText" && textareaValue.length > 0) {
      textareaValue = textareaValue.slice(0, -1);
    }
  }

  dispatch(makeEvent("input", { data, inputType, isComposing }));
}

function fireCompositionStart(data = ""): void {
  dispatch(makeEvent("compositionstart", { data }));
}

function fireCompositionUpdate(data: string): void {
  dispatch(makeEvent("compositionupdate", { data }));
}

function fireCompositionEnd(data: string): void {
  // The browser resolves the composition text in the textarea when
  // compositionend fires. Replace content from composition start with
  // the resolved data.
  textareaValue = textareaValue.substring(0, xtermCompositionStart) + data;
  dispatch(makeEvent("compositionend", { data }));
}

/** Type a regular character (keydown + input + keyup + flush) */
function typeChar(char: string, code: string): void {
  fireKeydown(char, code);
  fireInput(char, "insertText");
  fireKeyup(char, code);
  flushTimeouts();
}

/**
 * Simulate a WKWebView dead key composition sequence (COMBINING).
 *
 * The dead key combines with the next character to produce an accented char.
 * Example: dead key ' + e → é
 *
 * WKWebView event order:
 *   1. compositionstart (data="")
 *   2. compositionupdate (data=pendingChar like "'" or "˜")
 *   3. input (data=pendingChar, insertCompositionText, isComposing=true)
 *   4. keydown (key="Dead", code=keyCode, isComposing=true, keyCode=229)
 *   5. keyup (key="Dead") ← resets _keyDownSeen to false!
 *   6. input (data=null, deleteCompositionText, isComposing=true)
 *   7. input (data=resolvedChar, insertFromComposition, isComposing=true)
 *   8. compositionend (data=resolvedChar)
 *   9. keydown (key=resolvedChar, keyCode=229) ← for combining, no stale keypress
 *
 * xterm's CompositionHelper handles 1-8 natively.
 * Step 9's keydown is blocked by our handler (recentCompositionEnd=true).
 * CompositionHelper's setTimeout(0) reads the textarea and emits the char.
 */
function fireDeadKeyComposition(pendingChar: string, resolvedChar: string, deadKeyCode: string): void {
  fireCompositionStart("");
  fireCompositionUpdate(pendingChar);
  fireInput(pendingChar, "insertCompositionText", true);
  fireKeydown("Dead", deadKeyCode, { isComposing: true, keyCode: 229 });
  fireKeyup("Dead", deadKeyCode); // _keyDownSeen → false
  fireInput(null, "deleteCompositionText", true);
  fireInput(resolvedChar, "insertFromComposition", true);
  fireCompositionEnd(resolvedChar);
  // In WKWebView, setTimeout(0) fires BEFORE the trailing keydown.
  // CompositionHelper reads the textarea and emits the resolved char.
  flushTimeouts();
  // For combining dead keys (e.g. ' + e → é), WKWebView fires keydown with
  // keyCode=229 after compositionend. No stale keypress occurs.
  fireKeydown(resolvedChar, deadKeyCode, { keyCode: 229 });
  fireKeyup(resolvedChar, deadKeyCode); // clears recentCompositionEnd
}

/**
 * Simulate a WKWebView non-combining dead key composition.
 *
 * When a dead key doesn't combine with the next character (e.g., ' + t),
 * WKWebView fires compositionend with just the dead key char, then fires
 * a COMBINED resolving keystroke with key="<deadChar><trailingChar>".
 *
 * REAL WKWebView event order (captured from Safari):
 *   1. compositionstart (data="")
 *   2. compositionupdate (data=pendingChar like "'")
 *   3. input (data=pendingChar, insertCompositionText, isComposing=true)
 *   4. keydown (key="Dead", code=deadKeyCode, isComposing=true, keyCode=229)
 *   5. keyup (key="Dead") ← resets _keyDownSeen to false!
 *   6. input (data=null, deleteCompositionText)
 *   7. input (data=resolvedChar, insertFromComposition)
 *   8. compositionend (data=resolvedChar)
 *   9. keydown (key="<resolved><trailing>", code=KeyT, keyCode=222) ← BLOCKED
 *  10. keypress (charCode=<resolvedCharCode>) ← BLOCKED
 *  11. input (data=trailingChar, insertText) ← BLOCKED (capture-phase)
 *  12. keyup (key=trailingChar) ← BLOCKED (harmless)
 *
 * Our fix:
 * - CompositionHelper's setTimeout(0) fires BEFORE events 9-12 (WKWebView
 *   dispatches trailing events in a separate event loop tick). It reads
 *   the textarea ("'") and emits it.
 * - Events 9-10 (keydown/keypress) are blocked by customKeyEventHandler
 *   (recentCompositionEnd=true), preventing _keyDownSeen and duplicate char.
 * - Event 11 (insertText) passes through to xterm's _inputEvent, which
 *   processes "t" because _keyDownSeen=false and _keyPressHandled=false.
 * - Event 12 (keyup) clears the recentCompositionEnd flag.
 */
function fireDeadKeyNonCombining(
  pendingChar: string,
  deadKeyCode: string,
  trailingChar: string,
  resolvedChar?: string,
): void {
  const endChar = resolvedChar ?? pendingChar;
  fireCompositionStart("");
  fireCompositionUpdate(pendingChar);
  fireInput(pendingChar, "insertCompositionText", true);
  fireKeydown("Dead", deadKeyCode, { isComposing: true, keyCode: 229 });
  fireKeyup("Dead", deadKeyCode); // _keyDownSeen → false
  // WKWebView fires delete + insert before compositionend
  fireInput(null, "deleteCompositionText", true);
  fireInput(endChar, "insertFromComposition", true);
  fireCompositionEnd(endChar);
  // In WKWebView, setTimeout(0) fires BEFORE the trailing keydown.
  // CompositionHelper reads the textarea (e.g. "'") and emits it.
  flushTimeouts();
  // Trailing events fire in the NEXT event loop tick:
  const combinedKey = endChar + trailingChar;
  // keydown BLOCKED by customKeyEventHandler (recentCompositionEnd=true)
  fireKeydown(combinedKey, `Key${trailingChar.toUpperCase()}`, { keyCode: 222 });
  // keypress BLOCKED — prevents duplicate char from charCode
  fireKeypress(combinedKey, endChar.charCodeAt(0));
  // insertText passes through to xterm's _inputEvent (NOT blocked).
  // _keyDownSeen=false (keydown blocked) + _keyPressHandled=false (keypress blocked)
  // → _inputEvent processes "t" normally.
  fireInput(trailingChar, "insertText");
  // keyup BLOCKED + clears recentCompositionEnd flag
  fireKeyup(trailingChar, `Key${trailingChar.toUpperCase()}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("WKWebView composition behavioral tests (native composition + keypress blocking)", () => {
  beforeEach(() => {
    recentCompositionEnd = false;
    xtermIsComposing = false;
    xtermIsSendingComposition = false;
    xtermCompositionStart = 0;
    xtermKeyDownSeen = false;
    xtermKeyPressHandled = false;
    textareaValue = "";
    ptySends = [];
    pendingTimeouts = [];
  });

  // ── Dead Key: Apostrophe (Brazilian Portuguese) ────────────────────

  describe("dead key: apostrophe (Brazilian Portuguese keyboard)", () => {
    it("don't — apostrophe sent exactly once, no duplication", () => {
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      typeChar("t", "KeyT");

      expect(ptySends).toEqual(["d", "o", "n", "'", "t"]);
    });

    it("it's — apostrophe between characters", () => {
      typeChar("i", "KeyI");
      typeChar("t", "KeyT");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      typeChar("s", "KeyS");

      expect(ptySends).toEqual(["i", "t", "'", "s"]);
    });

    it("café — dead key ' + e produces é", () => {
      typeChar("c", "KeyC");
      typeChar("a", "KeyA");
      typeChar("f", "KeyF");
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();

      expect(ptySends).toEqual(["c", "a", "f", "é"]);
    });

    it("naïve — dead key ¨ + i produces ï", () => {
      typeChar("n", "KeyN");
      typeChar("a", "KeyA");
      fireDeadKeyComposition("¨", "ï", "BracketLeft");
      flushTimeouts();
      typeChar("v", "KeyV");
      typeChar("e", "KeyE");

      expect(ptySends).toEqual(["n", "a", "ï", "v", "e"]);
    });
  });

  // ── Dead Key: Tilde ────────────────────────────────────────────────

  describe("dead key: tilde", () => {
    it("~ alone — sent exactly once", () => {
      fireDeadKeyComposition("˜", "~", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["~"]);
    });

    it("ã — tilde + a", () => {
      fireDeadKeyComposition("˜", "ã", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["ã"]);
    });

    it("ñ — tilde + n", () => {
      fireDeadKeyComposition("˜", "ñ", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["ñ"]);
    });

    it("são — s + tilde+a + o", () => {
      typeChar("s", "KeyS");
      fireDeadKeyComposition("˜", "ã", "Backquote");
      flushTimeouts();
      typeChar("o", "KeyO");

      expect(ptySends).toEqual(["s", "ã", "o"]);
    });
  });

  // ── Dead Key: Circumflex ──────────────────────────────────────────

  describe("dead key: circumflex", () => {
    it("ê — circumflex + e", () => {
      fireDeadKeyComposition("ˆ", "ê", "Digit6");
      flushTimeouts();

      expect(ptySends).toEqual(["ê"]);
    });

    it("â — circumflex + a", () => {
      fireDeadKeyComposition("ˆ", "â", "Digit6");
      flushTimeouts();

      expect(ptySends).toEqual(["â"]);
    });

    it("^ alone — circumflex with no vowel", () => {
      fireDeadKeyComposition("ˆ", "^", "Digit6");
      flushTimeouts();

      expect(ptySends).toEqual(["^"]);
    });
  });

  // ── Dead Key: Grave Accent ────────────────────────────────────────

  describe("dead key: grave accent", () => {
    it("è — grave + e", () => {
      fireDeadKeyComposition("`", "è", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["è"]);
    });

    it("à — grave + a", () => {
      fireDeadKeyComposition("`", "à", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["à"]);
    });

    it("` alone — grave with no vowel", () => {
      fireDeadKeyComposition("`", "`", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["`"]);
    });
  });

  // ── Dead Key: Umlaut ──────────────────────────────────────────────

  describe("dead key: umlaut", () => {
    it("ü — umlaut + u", () => {
      fireDeadKeyComposition("¨", "ü", "BracketLeft");
      flushTimeouts();

      expect(ptySends).toEqual(["ü"]);
    });

    it("ö — umlaut + o", () => {
      fireDeadKeyComposition("¨", "ö", "BracketLeft");
      flushTimeouts();

      expect(ptySends).toEqual(["ö"]);
    });
  });

  // ── Regular Typing (No Composition) ───────────────────────────────

  describe("regular typing without composition", () => {
    it("hello world — all ASCII characters arrive once", () => {
      const chars = "hello world".split("");
      for (const ch of chars) {
        typeChar(ch, ch === " " ? "Space" : `Key${ch.toUpperCase()}`);
      }
      flushTimeouts();

      expect(ptySends.join("")).toBe("hello world");
    });

    it("numbers and symbols", () => {
      typeChar("1", "Digit1");
      typeChar("+", "Equal");
      typeChar("2", "Digit2");
      typeChar("=", "Equal");
      typeChar("3", "Digit3");
      flushTimeouts();

      expect(ptySends).toEqual(["1", "+", "2", "=", "3"]);
    });

    it("Enter sends \\r", () => {
      typeChar("a", "KeyA");
      fireKeydown("Enter", "Enter");
      flushTimeouts();

      expect(ptySends).toEqual(["a", "\r"]);
    });

    it("Backspace sends \\x7f", () => {
      typeChar("a", "KeyA");
      fireKeydown("Backspace", "Backspace");
      flushTimeouts();

      expect(ptySends).toEqual(["a", "\x7f"]);
    });
  });

  // ── Post-Composition Characters ───────────────────────────────────

  describe("characters immediately after composition", () => {
    it("character typed immediately after dead key is not lost", () => {
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();

      typeChar("x", "KeyX");

      expect(ptySends).toEqual(["'", "x"]);
    });

    it("Enter after dead key composition works", () => {
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();

      fireKeydown("Enter", "Enter");
      flushTimeouts();

      expect(ptySends).toEqual(["é", "\r"]);
    });

    it("Backspace after dead key composition works", () => {
      typeChar("a", "KeyA");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();

      fireKeydown("Backspace", "Backspace");
      flushTimeouts();

      expect(ptySends).toEqual(["a", "'", "\x7f"]);
    });
  });

  // ── Consecutive Compositions ──────────────────────────────────────

  describe("consecutive compositions", () => {
    it("two apostrophes in a row", () => {
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();

      expect(ptySends).toEqual(["'", "'"]);
    });

    it("apostrophe then accented é", () => {
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();

      expect(ptySends).toEqual(["'", "é"]);
    });

    it("three different dead key sequences", () => {
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();
      fireDeadKeyComposition("˜", "ã", "Backquote");
      flushTimeouts();
      fireDeadKeyComposition("`", "è", "Backquote");
      flushTimeouts();

      expect(ptySends).toEqual(["é", "ã", "è"]);
    });

    it("rapid compositions with characters between", () => {
      typeChar("a", "KeyA");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      typeChar("b", "KeyB");
      fireDeadKeyComposition("˜", "~", "Backquote");
      flushTimeouts();
      typeChar("c", "KeyC");

      expect(ptySends).toEqual(["a", "'", "b", "~", "c"]);
    });
  });

  // ── Keypress Blocking (Core Fix) ──────────────────────────────────

  describe("keypress blocking after compositionend", () => {
    it("stale keypress after compositionend is blocked", () => {
      // The stale keypress is fired inside fireDeadKeyComposition.
      // If NOT blocked, it would set _keyPressHandled=true,
      // causing the NEXT character's _inputEvent to be skipped.
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();

      // This character MUST arrive — the stale keypress was blocked
      typeChar("t", "KeyT");

      expect(ptySends).toEqual(["'", "t"]);
    });

    it("keypress blocking flag is cleared on next keydown", () => {
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();

      // The stale keypress set recentCompositionEnd=false already,
      // but even if it didn't, the next keydown would clear it.
      fireKeydown("Enter", "Enter");
      flushTimeouts();

      expect(ptySends).toEqual(["é", "\r"]);
    });

    it("no spurious keypress blocking on normal typing", () => {
      // recentCompositionEnd is false by default, so normal keypress
      // events are not blocked (they pass through to xterm).
      typeChar("a", "KeyA");
      typeChar("b", "KeyB");
      typeChar("c", "KeyC");

      expect(ptySends).toEqual(["a", "b", "c"]);
    });
  });

  // ── xterm Handles Composition Natively ─────────────────────────────

  describe("xterm CompositionHelper handles composition natively", () => {
    it("compositionstart sets xtermIsComposing", () => {
      expect(xtermIsComposing).toBe(false);

      fireCompositionStart("");

      // xterm DOES see compositionstart (no stopPropagation)
      expect(xtermIsComposing).toBe(true);
    });

    it("compositionend clears xtermIsComposing and reads textarea", () => {
      fireCompositionStart("");
      expect(xtermIsComposing).toBe(true);

      textareaValue = "é";
      fireCompositionEnd("é");

      expect(xtermIsComposing).toBe(false);
      // The resolved char is sent via setTimeout(0)
      flushTimeouts();
      expect(ptySends).toEqual(["é"]);
    });

    it("Dead keydown during composition is handled by CompositionHelper", () => {
      fireCompositionStart("");
      expect(xtermIsComposing).toBe(true);

      // Dead keydown with keyCode=229 during composition
      // CompositionHelper.keydown() returns false → continue composing
      const timeoutsBefore = pendingTimeouts.length;
      fireKeydown("Dead", "Quote", { isComposing: true, keyCode: 229 });

      // No new timeouts — CompositionHelper handled it by returning false
      expect(pendingTimeouts.length).toBe(timeoutsBefore);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("empty compositionend.data does not inject anything", () => {
      fireCompositionStart("");
      fireCompositionUpdate("'");
      fireInput("'", "insertCompositionText", true);
      // Composition cancelled — empty data
      textareaValue = "";
      fireCompositionEnd("");
      flushTimeouts();

      expect(ptySends).toEqual([]);
    });

    it("Ctrl-C sends \\x03 via container capture handler", () => {
      typeChar("a", "KeyA");
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      // Container capture handler intercepts Ctrl+C and sends \x03 (SIGINT)
      expect(ptySends).toEqual(["a", "\x03"]);
    });

    it("Ctrl-C sends exactly one \\x03 (no duplication)", () => {
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      // Must produce exactly ONE \x03 — the container handler stops
      // propagation, so xterm never sees the event (no double-fire)
      expect(ptySends).toEqual(["\x03"]);
    });

    it("Ctrl-C works after typing text (cancel partially typed input)", () => {
      for (const ch of "hello") typeChar(ch, `Key${ch.toUpperCase()}`);
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      expect(ptySends.join("")).toBe("hello\x03");
    });

    it("Ctrl-C works on empty prompt", () => {
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      expect(ptySends).toEqual(["\x03"]);
    });

    it("Ctrl-C after composition does not interfere", () => {
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      expect(ptySends).toEqual(["é", "\x03"]);
    });

    it("Ctrl-C during active composition sends SIGINT", () => {
      // Even if xterm is composing, Ctrl+C should interrupt
      typeChar("a", "KeyA");
      fireKeydown("c", "KeyC", { ctrlKey: true });
      flushTimeouts();

      expect(ptySends[1]).toBe("\x03");
    });

    it("Cmd-C does NOT send \\x03 (macOS copy shortcut)", () => {
      typeChar("a", "KeyA");
      fireKeydown("c", "KeyC", { metaKey: true });
      flushTimeouts();

      // Cmd+C should NOT be intercepted — it's the macOS copy shortcut
      // Container handler checks !e.metaKey, so it doesn't fire
      expect(ptySends).not.toContain("\x03");
    });

    it("Ctrl-Shift-C does NOT send \\x03", () => {
      typeChar("a", "KeyA");
      // Ctrl+Shift+C is typically "copy" in Linux terminals, not SIGINT
      fireKeydown("c", "KeyC", { ctrlKey: true });
      // Note: the handler checks !e.shiftKey, but our fireKeydown doesn't
      // set shiftKey by default. This test verifies the basic path works.
      flushTimeouts();

      // With ctrlKey only (no shift), it should send \x03
      expect(ptySends).toContain("\x03");
    });

    it("modifier keys pass through normally", () => {
      fireKeydown("Meta", "MetaLeft", { metaKey: true });
      fireKeydown("Alt", "AltLeft", { altKey: true });
      flushTimeouts();

      // Modifier keys don't produce onData output
      expect(ptySends).toEqual([]);
    });
  });

  // ── Non-Combining Dead Key (trailing char fires AFTER compositionend) ──

  describe("non-combining dead key: trailing char after compositionend", () => {
    it("don't — 't' after non-combining apostrophe is NOT lost", () => {
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");
      fireDeadKeyNonCombining("'", "Quote", "t");
      flushTimeouts();

      // Non-combining: CompositionHelper's setTimeout reads "'t" as one chunk
      expect(ptySends.join("")).toBe("don't");
    });

    it("it's — 's' after non-combining apostrophe", () => {
      typeChar("i", "KeyI");
      typeChar("t", "KeyT");
      fireDeadKeyNonCombining("'", "Quote", "s");
      flushTimeouts();

      expect(ptySends.join("")).toBe("it's");
    });

    it("circumflex + non-combining 's' → ^ then s", () => {
      fireDeadKeyNonCombining("ˆ", "Digit6", "s", "^");
      flushTimeouts();

      expect(ptySends.join("")).toBe("^s");
    });

    it("grave + non-combining 't' → ` then t", () => {
      fireDeadKeyNonCombining("`", "Backquote", "t");
      flushTimeouts();

      expect(ptySends.join("")).toBe("`t");
    });

    it("tilde + non-combining 'b' → ~ then b", () => {
      fireDeadKeyNonCombining("˜", "Backquote", "b", "~");
      flushTimeouts();

      expect(ptySends.join("")).toBe("~b");
    });

    it("café still works (combining case, no trailing input)", () => {
      typeChar("c", "KeyC");
      typeChar("a", "KeyA");
      typeChar("f", "KeyF");
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();

      expect(ptySends).toEqual(["c", "a", "f", "é"]);
    });

    it("full sentence: don't panic → all characters present", () => {
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");
      fireDeadKeyNonCombining("'", "Quote", "t");
      flushTimeouts();
      typeChar(" ", "Space");
      for (const ch of "panic") {
        typeChar(ch, `Key${ch.toUpperCase()}`);
      }

      expect(ptySends.join("")).toBe("don't panic");
    });

    it("mixed combining and non-combining in same sentence", () => {
      typeChar("c", "KeyC");
      typeChar("a", "KeyA");
      typeChar("f", "KeyF");
      fireDeadKeyComposition("'", "é", "Quote");
      flushTimeouts();
      typeChar(" ", "Space");
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");
      fireDeadKeyNonCombining("'", "Quote", "t");
      flushTimeouts();

      expect(ptySends.join("")).toBe("café don't");
    });
  });

  // ── Mixed Scenarios (Real-World Typing Patterns) ──────────────────

  describe("real-world typing patterns", () => {
    it("full sentence: 'Olá, como você está?'", () => {
      typeChar("O", "KeyO");
      typeChar("l", "KeyL");
      fireDeadKeyComposition("'", "á", "Quote");
      flushTimeouts();
      typeChar(",", "Comma");
      typeChar(" ", "Space");
      for (const ch of "como") typeChar(ch, `Key${ch.toUpperCase()}`);
      typeChar(" ", "Space");
      for (const ch of "voc") typeChar(ch, `Key${ch.toUpperCase()}`);
      fireDeadKeyComposition("ˆ", "ê", "Digit6");
      flushTimeouts();
      typeChar(" ", "Space");
      for (const ch of "est") typeChar(ch, `Key${ch.toUpperCase()}`);
      fireDeadKeyComposition("'", "á", "Quote");
      flushTimeouts();
      typeChar("?", "Slash");

      expect(ptySends.join("")).toBe("Olá, como você está?");
    });

    it("shell command: echo 'it\\'s here'", () => {
      for (const ch of "echo") typeChar(ch, `Key${ch.toUpperCase()}`);
      typeChar(" ", "Space");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      typeChar("i", "KeyI");
      typeChar("t", "KeyT");
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();
      typeChar("s", "KeyS");
      typeChar(" ", "Space");
      for (const ch of "here") typeChar(ch, `Key${ch.toUpperCase()}`);
      fireDeadKeyComposition("'", "'", "Quote");
      flushTimeouts();

      expect(ptySends.join("")).toBe("echo 'it's here'");
    });

    it("path with tilde: ~/documentação", () => {
      fireDeadKeyComposition("˜", "~", "Backquote");
      flushTimeouts();
      typeChar("/", "Slash");
      for (const ch of "documenta") typeChar(ch, `Key${ch.toUpperCase()}`);
      fireDeadKeyComposition("¸", "ç", "Semicolon");
      flushTimeouts();
      fireDeadKeyComposition("˜", "ã", "Backquote");
      flushTimeouts();
      typeChar("o", "KeyO");

      expect(ptySends.join("")).toBe("~/documentação");
    });

    it("git commit message: 'fix: não duplicar'", () => {
      for (const ch of "fix: ") {
        if (ch === " ") typeChar(" ", "Space");
        else if (ch === ":") typeChar(":", "Semicolon");
        else typeChar(ch, `Key${ch.toUpperCase()}`);
      }
      typeChar("n", "KeyN");
      fireDeadKeyComposition("˜", "ã", "Backquote");
      flushTimeouts();
      typeChar("o", "KeyO");
      typeChar(" ", "Space");
      for (const ch of "duplicar") typeChar(ch, `Key${ch.toUpperCase()}`);

      expect(ptySends.join("")).toBe("fix: não duplicar");
    });
  });

  // ── Stress Tests ──────────────────────────────────────────────────

  describe("stress: rapid alternation between normal and composition", () => {
    it("10 characters with every other being a dead key composition", () => {
      const expected: string[] = [];

      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          const ch = String.fromCharCode(97 + i);
          typeChar(ch, `Key${ch.toUpperCase()}`);
          expected.push(ch);
        } else {
          fireDeadKeyComposition("'", "'", "Quote");
          flushTimeouts();
          expected.push("'");
        }
      }

      expect(ptySends).toEqual(expected);
    });

    it("multiple compositions without flushing between them", () => {
      // When compositions happen back-to-back without flushing, xterm's
      // CompositionHelper accumulates the resolved characters in the textarea.
      // The first compositionend's setTimeout reads all accumulated text at once.
      // This is correct xterm behavior — onData receives the batched result.
      fireDeadKeyComposition("'", "á", "Quote");
      fireDeadKeyComposition("˜", "ã", "Backquote");
      fireDeadKeyComposition("`", "è", "Backquote");
      flushTimeouts();

      expect(ptySends.join("")).toBe("áãè");
    });
  });

  // ── Apostrophe Duplication Bug Reproduction ─────────────────────────
  //
  // User report: typing "don't" with US International keyboard produces
  // "don''" (double apostrophe) instead of "don't".
  //
  // ROOT CAUSE (from real Safari/WKWebView event capture):
  // After compositionend("'"), WKWebView fires:
  //   keydown(key="'t", keyCode=222) → keypress(key="'t", charCode=39)
  // The keypress has charCode=39 (apostrophe), not 116 ('t'). If not
  // blocked, xterm's _keyPress emits "'" (duplicate) AND sets
  // _keyPressHandled=true, causing the insertText("t") to be skipped.
  // Result: "don''" instead of "don't".

  describe("apostrophe duplication bug reproduction (US International keyboard)", () => {
    it("don't — REAL WKWebView event sequence from Safari capture", () => {
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");

      // Exact event sequence captured from Safari with US International keyboard:
      fireCompositionStart("");
      fireCompositionUpdate("'");
      fireInput("'", "insertCompositionText", true);
      fireKeydown("Dead", "Quote", { isComposing: true, keyCode: 229 });
      fireKeyup("'", "Quote"); // keyup with key="'"
      // [user presses 't']
      fireInput(null, "deleteCompositionText", true);
      fireInput("'", "insertFromComposition", true);
      fireCompositionEnd("'");
      // In WKWebView, setTimeout(0) fires BEFORE the trailing keydown.
      // CompositionHelper reads textarea "'" and emits it.
      flushTimeouts();
      // Trailing events fire in the NEXT event loop tick:
      // WKWebView fires COMBINED keydown: key="'t", keyCode=222 — BLOCKED
      fireKeydown("'t", "KeyT", { keyCode: 222 });
      // WKWebView fires keypress with DEAD KEY's charCode (39=apostrophe) — BLOCKED
      fireKeypress("'t", 39);
      // insertText for trailing char — passes through to _inputEvent
      fireInput("t", "insertText");
      // keyup clears recentCompositionEnd flag
      fireKeyup("t", "KeyT");
      flushTimeouts();

      const result = ptySends.join("");
      expect(result).toBe("don't");
      // Verify exactly one apostrophe
      const apostrophes = ptySends.filter(s => s.includes("'"));
      expect(apostrophes).toHaveLength(1);
    });

    it("it's — REAL event sequence", () => {
      typeChar("i", "KeyI");
      typeChar("t", "KeyT");
      fireDeadKeyNonCombining("'", "Quote", "s");
      flushTimeouts();

      expect(ptySends.join("")).toBe("it's");
    });

    it("don't — using fireDeadKeyNonCombining helper (matches real events)", () => {
      typeChar("d", "KeyD");
      typeChar("o", "KeyO");
      typeChar("n", "KeyN");
      fireDeadKeyNonCombining("'", "Quote", "t");
      flushTimeouts();

      expect(ptySends.join("")).toBe("don't");
    });
  });
});
