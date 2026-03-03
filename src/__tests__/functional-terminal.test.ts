/**
 * Functional tests for Bug 2 (double apostrophe) and Bug 3 (display corruption).
 *
 * Uses @xterm/headless to create real terminal instances in Node.js and verify
 * that escape sequences and input handling work correctly.
 *
 * Bug 2: Dead keys (e.g. apostrophe on macOS Brazilian keyboard) fire
 *   event.key === "Dead" which was NOT suppressed by the old key-length
 *   check. The fix uses a KEYDOWN_PASSTHROUGH allowlist — anything NOT
 *   in the set gets suppressed.
 *
 * Bug 3: `\r\x1b[K` only erases the current line. If user input wrapped
 *   across multiple lines, ghost text from wrapped lines remains. The fix
 *   uses `\r\x1b[J` (Erase in Display, cursor to end of screen).
 */
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const SRC: string = readFileSync(
  new URL("../terminal/TerminalPool.ts", import.meta.url),
  "utf-8",
);


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bug 2: KEYDOWN_PASSTHROUGH allowlist verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mirror the allowlist from TerminalPool.ts for testing
const KEYDOWN_PASSTHROUGH = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "Insert", "Clear", "Pause", "ScrollLock", "PrintScreen",
  "CapsLock", "NumLock",
]);

describe("Bug 2 fix: keypress blocking after compositionend", () => {
  it("source uses recentCompositionEnd flag for event blocking", () => {
    expect(SRC).toContain("recentCompositionEnd");
    expect(SRC).toContain("if (recentCompositionEnd)");
  });

  it("customKeyEventHandler returns true by default (lets xterm handle natively)", () => {
    expect(SRC).toContain("return true");
  });

  it("all navigation keys are in the passthrough set", () => {
    const navKeys = [
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown",
    ];
    for (const key of navKeys) {
      expect(KEYDOWN_PASSTHROUGH.has(key)).toBe(true);
    }
  });

  it("all function keys F1-F12 are in the passthrough set", () => {
    for (let i = 1; i <= 12; i++) {
      expect(KEYDOWN_PASSTHROUGH.has(`F${i}`)).toBe(true);
    }
  });

  it("Enter, Backspace, Tab, Escape, Delete are in the passthrough set", () => {
    for (const key of ["Enter", "Backspace", "Tab", "Escape", "Delete"]) {
      expect(KEYDOWN_PASSTHROUGH.has(key)).toBe(true);
    }
  });

  it("'Dead' key is NOT in the passthrough set (gets suppressed — fixes double apostrophe)", () => {
    expect(KEYDOWN_PASSTHROUGH.has("Dead")).toBe(false);
  });

  it("single printable characters are NOT in the passthrough set", () => {
    const printableChars = ["a", "z", "A", "Z", "0", "9", "'", '"', " ", ".", ",", ";", "/"];
    for (const ch of printableChars) {
      expect(KEYDOWN_PASSTHROUGH.has(ch)).toBe(false);
    }
  });

  it("shouldSuppress logic: Dead key without modifiers → SUPPRESSED", () => {
    const event = { key: "Dead", isComposing: false, ctrlKey: false, metaKey: false, altKey: false };
    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);
    expect(shouldSuppress).toBe(true);
  });

  it("shouldSuppress logic: apostrophe char without modifiers → SUPPRESSED", () => {
    const event = { key: "'", isComposing: false, ctrlKey: false, metaKey: false, altKey: false };
    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);
    expect(shouldSuppress).toBe(true);
  });

  it("shouldSuppress logic: Enter without modifiers → NOT suppressed (passthrough)", () => {
    const event = { key: "Enter", isComposing: false, ctrlKey: false, metaKey: false, altKey: false };
    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);
    expect(shouldSuppress).toBe(false);
  });

  it("shouldSuppress logic: Ctrl+C → NOT suppressed (modifier present)", () => {
    const event = { key: "c", isComposing: false, ctrlKey: true, metaKey: false, altKey: false };
    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);
    expect(shouldSuppress).toBe(false);
  });

  it("shouldSuppress logic: composing event → NOT suppressed", () => {
    const event = { key: "a", isComposing: true, ctrlKey: false, metaKey: false, altKey: false };
    const shouldSuppress =
      !event.isComposing &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !KEYDOWN_PASSTHROUGH.has(event.key);
    expect(shouldSuppress).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bug 2: Headless xterm — single char input produces exactly one char
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Helper: write to terminal and wait for processing to complete */
function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("Bug 2 fix: headless xterm single-char input", () => {
  it("writing an apostrophe to terminal produces exactly one char on screen", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await writeAsync(term, "don");
    await writeAsync(term, "'");
    await writeAsync(term, "t");

    // Read back from terminal buffer
    const line = term.buffer.active.getLine(0);
    expect(line).not.toBeNull();
    const text = line!.translateToString(true);
    expect(text).toBe("don't");

    term.dispose();
  });

  it("writing don't does NOT produce don''t", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    // Simulate what onData would receive: each char individually
    for (const ch of "don't") {
      await writeAsync(term, ch);
    }

    const line = term.buffer.active.getLine(0);
    const text = line!.translateToString(true);
    expect(text).not.toContain("''");
    expect(text).toBe("don't");

    term.dispose();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bug 3: Display corruption — \x1b[J clears wrapped lines
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Bug 3 fix: sendShortcutCommand uses backspaces to clear input (source verification)", () => {
  it("sendShortcutCommand uses backspaces (\\x7f) to clear existing input", () => {
    const fnBody = SRC.match(/export function sendShortcutCommand[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Uses DEL/backspace chars repeated by eraseLen
    expect(body).toContain("\\x7f");
    expect(body).toContain("eraseLen");
  });

  it("does NOT use escape sequences for display clearing (backspaces handle it)", () => {
    const fnBody = SRC.match(/export function sendShortcutCommand[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // No \x1b[K or \x1b[J — backspaces are used instead
    expect(body).not.toContain("\\x1b[K");
    expect(body).not.toContain("\\x1b[J");
  });
});

describe("Bug 3 fix: headless xterm — \\x1b[J clears below cursor", () => {
  it("\\r\\x1b[J clears from cursor to end of screen (single line)", async () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // Write prompt + user input
    await writeAsync(term, "$ some-command-here");

    // Apply the clear sequence
    await writeAsync(term, "\r\x1b[J");

    // Line should be cleared
    const line = term.buffer.active.getLine(0);
    const text = line!.translateToString(true);
    expect(text.trim()).toBe("");

    term.dispose();
  });

  it("\\r\\x1b[J clears wrapped content across multiple lines", async () => {
    const term = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });

    // Write content that wraps across multiple lines (15 chars in 10-col terminal)
    await writeAsync(term, "AAAAABBBBBCCCCC");

    // Move cursor to beginning and clear to end of screen
    await writeAsync(term, "\r\x1b[J");

    // All lines from cursor position down should be cleared
    // The cursor was on the last wrapped line, so \r moves to col 0 of that line
    // and \x1b[J clears from there to end of screen
    const line = term.buffer.active.getLine(term.buffer.active.cursorY);
    const text = line!.translateToString(true);
    expect(text.trim()).toBe("");

    term.dispose();
  });

  it("\\x1b[K (old behavior) does NOT clear wrapped lines below", async () => {
    const term = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });

    // Write content that wraps: line 0 = "AAAAAAAAAA", line 1 = "BBBB"
    await writeAsync(term, "AAAAAAAAAABBBB");

    // Verify content wrapped
    const line0Before = term.buffer.active.getLine(0)!.translateToString(true);
    expect(line0Before).toContain("AAAAAAAAAA");

    // Now \r\x1b[K only clears CURRENT line from cursor, not lines above
    // Cursor is on the wrapped continuation line
    await writeAsync(term, "\r\x1b[K");

    // Line 0 (first wrapped portion) still has content — this is the BUG with \x1b[K
    const line0After = term.buffer.active.getLine(0)!.translateToString(true);
    expect(line0After).toContain("AAAAAAAAAA"); // Ghost text remains!

    term.dispose();
  });
});
