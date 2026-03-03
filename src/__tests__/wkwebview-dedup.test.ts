/**
 * WKWebView Dead Key Fix — Architecture Verification
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE BUG:
 *
 * WKWebView (Tauri macOS) fires a stale keypress event after dead key
 * compositionend. xterm's _keyPress processes this and sets
 * _keyPressHandled=true, which causes _inputEvent to skip the NEXT
 * character (e.g. "t" in don't is lost).
 *
 * Additionally, xterm's _keyDownSeen flag was set BEFORE the custom
 * key handler check, blocking the _inputEvent path for characters
 * after composition.
 *
 * THE FIX (2 layers):
 *
 * 1. patch-package: Moves _keyDownSeen=true AFTER the custom handler
 *    check in xterm's _keyDown, so returning false from the handler
 *    prevents _keyDownSeen from being set.
 *
 * 2. Event blocking after compositionend: Block keydown/keypress/keyup
 *    via customKeyEventHandler returning false, preventing _keyDownSeen
 *    from being set and the stale keypress from being processed.
 *    insertText input events pass through to xterm's _inputEvent
 *    (which works because _keyDownSeen=false and _keyPressHandled=false).
 *    CompositionHelper's setTimeout(0) emits the dead key char;
 *    _inputEvent emits the trailing char. Flag cleared on keyup.
 *
 * xterm's CompositionHelper handles ALL composition events natively.
 * We do NOT intercept/stopPropagation on composition events.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const SRC: string = readFileSync(
  new URL("../terminal/TerminalPool.ts", import.meta.url),
  "utf-8",
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE: New approach — native composition + targeted keypress block
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SOURCE: native composition + keypress blocking architecture", () => {
  it("has recentCompositionEnd flag for keypress blocking", () => {
    expect(SRC).toContain("let recentCompositionEnd = false");
  });

  it("compositionend listener sets recentCompositionEnd (capture phase, no stopPropagation)", () => {
    const handler = SRC.match(
      /addEventListener\("compositionend"[\s\S]*?\}, true\)/
    );
    expect(handler).not.toBeNull();
    expect(handler![0]).toContain("recentCompositionEnd = true");
    // Must NOT stop propagation — xterm needs to see the event
    expect(handler![0]).not.toContain("stopPropagation");
  });

  it("compositionend handler is gated behind isMac", () => {
    expect(SRC).toContain("if (isMac)");
  });

  it("blocks ALL keyboard events when recentCompositionEnd is true (keypress check)", () => {
    // The handler checks recentCompositionEnd for ALL keyboard events
    expect(SRC).toContain("if (recentCompositionEnd)");
    expect(SRC).toContain("return false");
  });

  it("blocks ALL keyboard events when recentCompositionEnd is true", () => {
    // The handler blocks ALL events (keydown, keypress, keyup) after
    // compositionend. This prevents _keyDownSeen from being set and
    // the stale keypress from being processed.
    expect(SRC).toContain("if (recentCompositionEnd)");
    expect(SRC).toContain("return false");
  });

  it("lets all other events through (returns true)", () => {
    expect(SRC).toContain("return true");
  });

  it("xterm patch file exists (patch-package)", () => {
    // @ts-expect-error — fs is a Node built-in, not in browser tsconfig
    const { existsSync } = require("fs");
    // @ts-expect-error — path is a Node built-in, not in browser tsconfig
    const { resolve } = require("path");
    const patchPath = resolve(__dirname, "../../patches/@xterm+xterm+6.0.0.patch");
    expect(existsSync(patchPath)).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE: Old approaches are REMOVED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SOURCE: old approaches fully removed", () => {
  it("no insideComposition flag (composition events reach xterm natively)", () => {
    expect(SRC).not.toContain("let insideComposition");
  });

  it("no lastInjectedChar (no manual injection from compositionend)", () => {
    expect(SRC).not.toContain("let lastInjectedChar");
  });

  it("no stopPropagation on composition events", () => {
    // Our compositionend handler must NOT stop propagation
    const handler = SRC.match(
      /addEventListener\("compositionend"[\s\S]*?\}, true\)/
    );
    if (handler) {
      expect(handler[0]).not.toContain("stopPropagation");
    }
    // Should not have compositionstart/update intercept handlers at all
    expect(SRC).not.toMatch(/addEventListener\("compositionstart"/);
    expect(SRC).not.toMatch(/addEventListener\("compositionupdate"/);
  });

  it("no insertText capture blocking (insertText passes through to _inputEvent)", () => {
    // insertText is NOT blocked — _inputEvent processes the trailing char
    // because _keyDownSeen=false (keydown blocked) and _keyPressHandled=false
    // (keypress blocked). No stopPropagation on input events.
    const handlerSection = SRC.match(/attachCustomKeyEventHandler[\s\S]*?terminal\.onData/);
    expect(handlerSection).not.toBeNull();
    expect(handlerSection![0]).not.toContain("stopPropagation");
  });

  it("flag cleared on keyup (not setTimeout)", () => {
    // WKWebView's setTimeout(0) fires BEFORE the trailing keydown, making
    // it useless for flag clearing. Keyup is always the last event.
    const handlerBlock = SRC.match(/attachCustomKeyEventHandler[\s\S]*?\}\)/);
    expect(handlerBlock).not.toBeNull();
    expect(handlerBlock![0]).toContain('"keyup"');
    expect(handlerBlock![0]).toContain("recentCompositionEnd = false");
  });

  it("no needTextareaScrub", () => {
    expect(SRC).not.toContain("needTextareaScrub");
  });

  it("no KEYDOWN_PASSTHROUGH (all keydowns pass through)", () => {
    expect(SRC).not.toContain("KEYDOWN_PASSTHROUGH.has");
  });

  it("no blockNextPrintableKeydown", () => {
    expect(SRC).not.toContain("blockNextPrintableKeydown");
  });

  it("no sentChars / textareaAccum", () => {
    expect(SRC).not.toMatch(/^\s+sentChars:\s*string/m);
    expect(SRC).not.toMatch(/^\s+textareaAccum:\s*string/m);
  });

  it("no suppressNextFlush", () => {
    expect(SRC).not.toContain("suppressNextFlush");
  });

  it("no old composition tracking flags", () => {
    expect(SRC).not.toContain("lastComposedChar");
    expect(SRC).not.toContain("postCompPassOne");
    expect(SRC).not.toContain("suppressOnePostComposition");
    expect(SRC).not.toContain("capturedTrailingInput");
    expect(SRC).not.toContain("lastCompUpdateData");
    expect(SRC).not.toContain("deadKeyPending");
    expect(SRC).not.toContain("insideDeadKeyComposition");
    expect(SRC).not.toContain("suppressInputForDeadKey");
    expect(SRC).not.toContain("inDeadKeySequence");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE: onData handler is clean
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SOURCE: onData handler is clean and simple", () => {
  it("onData calls handleTerminalInput directly", () => {
    expect(SRC).toContain("terminal.onData((data)");
    expect(SRC).toContain("handleTerminalInput(sessionId, data)");
  });

  it("no debug logging", () => {
    expect(SRC).not.toContain("_dbgLog");
    expect(SRC).not.toContain("_dbgFlush");
    expect(SRC).not.toContain('"debug_log"');
    expect(SRC).not.toContain("SEND:");
    expect(SRC).not.toContain("_evLog");
    expect(SRC).not.toContain("_flushLog");
  });
});
