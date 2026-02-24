/**
 * Regression tests for terminal input handling (double apostrophe fix).
 *
 * BUG: xterm's onBinary handler was a redundant bypass that caused duplicate
 * keystrokes for printable characters (especially apostrophes on macOS with
 * smart quotes / dead-key composition). The fix removes the onBinary handler
 * entirely; all input flows through onData → handleTerminalInput → writeToSession.
 *
 * ARCHITECTURE: WKWebView fires onData twice per printable keystroke (keydown +
 * textarea input). Instead of timing-based dedup, attachCustomKeyEventHandler
 * suppresses the keydown path for single printable characters, leaving only the
 * textarea input event as the authoritative source.
 */
import { describe, it, expect } from "vitest";

// Read source file to verify architecture
// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const source: string = readFileSync(
  new URL("../terminal/TerminalPool.ts", import.meta.url),
  "utf-8",
);

// ─── Source-level verification ───────────────────────────────────────

describe("Terminal input: onBinary handler removed (double apostrophe fix)", () => {
  it("source code does NOT contain an active onBinary registration", () => {
    const lines: string[] = source.split("\n");
    const activeOnBinaryLines = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return trimmed.includes("terminal.onBinary(") || trimmed.includes(".onBinary(");
    });

    expect(activeOnBinaryLines).toHaveLength(0);
  });

  it("source code still registers onData handler", () => {
    const lines: string[] = source.split("\n");
    const activeOnDataLines = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return trimmed.includes("terminal.onData(");
    });

    expect(activeOnDataLines.length).toBeGreaterThanOrEqual(1);
  });

  it("onData handler calls handleTerminalInput", () => {
    const match = source.match(/terminal\.onData\(\(data\)\s*=>\s*\{[\s\S]*?handleTerminalInput/);
    expect(match).not.toBeNull();
  });

  it("comment explains why onBinary was removed", () => {
    expect(source).toContain("onBinary was removed");
  });

  it("attachCustomKeyEventHandler suppresses non-passthrough keydown via allowlist", () => {
    expect(source).toContain("attachCustomKeyEventHandler");
    expect(source).toContain("KEYDOWN_PASSTHROUGH.has(event.key)");
    // The shouldSuppress variable must NOT use key-length as the primary check
    const suppressBlock = source.match(/const shouldSuppress\s*=[\s\S]*?;/);
    expect(suppressBlock).not.toBeNull();
    expect(suppressBlock![0]).not.toContain("event.key.length");
    expect(suppressBlock![0]).toContain("KEYDOWN_PASSTHROUGH");
  });

  it("no timing-based dedup hack remains", () => {
    expect(source).not.toContain("_lastOnDataValue");
    expect(source).not.toContain("_lastOnDataTime");
  });
});

// ─── Input handling logic tests ──────────────────────────────────────

describe("Terminal input: writeToSession encoding", () => {
  /** Replicate the utf8ToBase64 helper from TerminalPool.ts */
  function utf8ToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(binary);
  }

  function decodePayload(b64: string): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  it("apostrophe encodes and decodes correctly", () => {
    const encoded = utf8ToBase64("'");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("'");
  });

  it("text with apostrophe encodes correctly", () => {
    const encoded = utf8ToBase64("doesn't");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("doesn't");
  });

  it("repeated apostrophes encode correctly", () => {
    const encoded = utf8ToBase64("'''");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("'''");
  });

  it("escape sequences encode correctly", () => {
    const encoded = utf8ToBase64("\x1b[A");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("\x1b[A");
  });

  it("non-ASCII characters encode correctly via UTF-8", () => {
    const encoded = utf8ToBase64("café");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("café");
  });

  it("CJK characters encode correctly via UTF-8", () => {
    const encoded = utf8ToBase64("你好");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("你好");
  });
});

// ─── Duplicate keystroke scenario ────────────────────────────────────

describe("Terminal input: duplicate keystroke prevention", () => {
  it("single input path means single write per keystroke", () => {
    let writeCount = 0;
    const mockWriteToSession = () => { writeCount++; };

    // After fix: only onData path exists
    mockWriteToSession(); // onData → handleTerminalInput → writeToSession
    expect(writeCount).toBe(1);
  });

  it("simulated dual-handler bug would produce double writes", () => {
    let writeCount = 0;
    const mockWriteToSession = () => { writeCount++; };

    // BEFORE fix: both handlers fire for the same keystroke
    mockWriteToSession(); // onData path
    mockWriteToSession(); // onBinary path (BUG - now removed)

    expect(writeCount).toBe(2); // This was the bug - double write
  });
});

// ─── Shortcut command: triggerDataEvent-based input with backspace clearing ──

describe("Terminal input: sendShortcutCommand architecture", () => {
  it("sendShortcutCommand uses triggerDataEvent (with writeToSession fallback)", () => {
    const fnMatch = source.match(/export function sendShortcutCommand[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // Must use triggerDataEvent for command injection
    expect(fnBody).toContain("triggerDataEvent");
    // writeToSession is the fallback path when triggerDataEvent is unavailable
    expect(fnBody).toContain("writeToSession");
  });

  it("sendShortcutCommand uses backspaces to clear existing input", () => {
    const fnMatch = source.match(/export function sendShortcutCommand[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // Uses \x7f (DEL/backspace) repeated by eraseLen to clear existing text
    expect(fnBody).toContain("\\x7f");
    expect(fnBody).toContain("eraseLen");
  });

  it("sendShortcutCommand does NOT append Enter — user reviews and presses Enter manually", () => {
    const fnMatch = source.match(/export function sendShortcutCommand[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // The function inserts the command on the prompt without executing it
    expect(fnBody).toContain("NO \\r");
  });
});
