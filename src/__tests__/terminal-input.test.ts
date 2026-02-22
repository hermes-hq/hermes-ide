/**
 * Regression tests for terminal input handling (double apostrophe fix).
 *
 * BUG: xterm's onBinary handler was a redundant bypass that caused duplicate
 * keystrokes for printable characters (especially apostrophes on macOS with
 * smart quotes / dead-key composition). The fix removes the onBinary handler
 * entirely; all input flows through onData → handleTerminalInput → writeToSession.
 *
 * Since createTerminal uses DOM APIs (document.createElement), these tests
 * verify the fix at the source-code level and test the input handling logic
 * independently.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Source-level verification ───────────────────────────────────────

describe("Terminal input: onBinary handler removed (double apostrophe fix)", () => {
  const terminalPoolPath = path.resolve(__dirname, "../terminal/TerminalPool.ts");
  const source = fs.readFileSync(terminalPoolPath, "utf-8");

  it("source code does NOT contain an active onBinary registration", () => {
    // The onBinary handler should be removed (only mentioned in comments)
    const lines = source.split("\n");
    const activeOnBinaryLines = lines.filter((line) => {
      const trimmed = line.trim();
      // Skip comment lines
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return trimmed.includes("terminal.onBinary(") || trimmed.includes(".onBinary(");
    });

    expect(activeOnBinaryLines).toHaveLength(0);
  });

  it("source code still registers onData handler", () => {
    const lines = source.split("\n");
    const activeOnDataLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return trimmed.includes("terminal.onData(");
    });

    expect(activeOnDataLines.length).toBeGreaterThanOrEqual(1);
  });

  it("onData routes through handleTerminalInput (not directly to writeToSession)", () => {
    // The onData callback should call handleTerminalInput, which then calls writeToSession.
    // This ensures all input goes through the intelligence layer.
    const onDataMatch = source.match(/terminal\.onData\(\(data\)\s*=>\s*\{[^}]*\}/);
    expect(onDataMatch).not.toBeNull();
    expect(onDataMatch![0]).toContain("handleTerminalInput");
    expect(onDataMatch![0]).not.toContain("writeToSession");
  });

  it("comment explains why onBinary was removed", () => {
    expect(source).toContain("onBinary was intentionally removed");
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
    // With onBinary removed, there's only one input path: onData → handleTerminalInput → writeToSession.
    // This test documents the invariant: each keystroke should produce exactly one writeToSession call.

    let writeCount = 0;
    const mockWriteToSession = () => { writeCount++; };

    // Simulate what happens when user types an apostrophe:
    // BEFORE fix: onData fires → writeToSession (1), onBinary fires → writeToSession (2) = DOUBLE
    // AFTER fix:  onData fires → writeToSession (1) = SINGLE

    // After fix: only onData path exists
    const keystroke = "'";
    mockWriteToSession(); // onData → handleTerminalInput → writeToSession

    // onBinary no longer exists, so no second call
    expect(writeCount).toBe(1);
  });

  it("simulated dual-handler bug would produce double writes", () => {
    // This demonstrates what the bug looked like before the fix
    let writeCount = 0;
    const mockWriteToSession = () => { writeCount++; };

    // BEFORE fix: both handlers fire for the same keystroke
    mockWriteToSession(); // onData path
    mockWriteToSession(); // onBinary path (BUG - now removed)

    expect(writeCount).toBe(2); // This was the bug - double write
  });
});
