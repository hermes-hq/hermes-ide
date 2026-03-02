/**
 * WKWebView Composition Flush Dedup — Bug Reproduction & Fix Verification
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW THIS REPRODUCES THE BUG:
 *
 * We cannot run a real WKWebView in Node.js, but the bug is deterministic:
 * it's caused by a specific event sequence that WKWebView always produces.
 * We build a faithful simulator of ALL components involved:
 *
 *   1. WKWebViewTextarea — models xterm's hidden <textarea> that accumulates
 *      all typed characters and is never cleared (this IS the root cause).
 *
 *   2. WKWebViewRuntime — models WKWebView's behavior of firing spurious
 *      compositionend events that flush the entire textarea content.
 *
 *   3. CompositionEndHandler — models our capture-phase compositionend
 *      handler (Layer 1 defense). Two versions: old (sentChars) and new
 *      (textareaAccum + event neutralization).
 *
 *   4. OnDataHandler — models our onData handler including the tertiary
 *      guard (Layer 2 defense).
 *
 *   5. HandleTerminalInput — models the dedup guard + writeToSession call
 *      (Layer 3 defense). Two versions: old (sentChars only) and new
 *      (textareaAccum primary + sentChars secondary).
 *
 * We wire these together into two complete pipelines:
 *   - OldPipeline: pre-fix logic (commit 978cf69)
 *   - NewPipeline: the fix (textareaAccum)
 *
 * Then we replay the EXACT event sequence WKWebView produces and verify:
 *   - OldPipeline: duplicate text reaches the PTY (BUG CONFIRMED)
 *   - NewPipeline: duplicate text is suppressed (FIX CONFIRMED)
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
// WKWebView Behavior Simulator
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SENT_CHARS_MAX = 512;
const TEXTAREA_ACCUM_MAX = 2048;

/**
 * Simulates xterm's hidden <textarea> element.
 *
 * In real xterm.js, the textarea accumulates all characters typed via keyboard
 * input events. It is NEVER cleared during normal typing — only on explicit
 * user actions like Cmd+A → Delete, which doesn't happen during terminal use.
 *
 * This is the ROOT CAUSE of the bug: the textarea grows forever while our
 * tracking state (sentChars) resets on Enter/Ctrl-C.
 */
class XtermTextarea {
  value = "";

  /** Append a character (models textarea 'input' event) */
  append(ch: string): void {
    if (ch.charCodeAt(0) >= 32) {
      this.value += ch;
    }
    // Control chars (Enter, Ctrl-C) do NOT clear the textarea.
    // This is the key behavior that causes the bug.
  }
}

/**
 * Models WKWebView's spurious compositionend behavior.
 *
 * Real WKWebView periodically fires compositionstart/compositionend events
 * even during normal typing (not just IME). The compositionend event's `data`
 * property contains the ENTIRE textarea value, not just the composed text.
 */
class WKWebViewRuntime {
  /** Fire a spurious compositionend — returns the textarea content as `data` */
  fireSpuriousCompositionEnd(textarea: XtermTextarea): string {
    return textarea.value;
  }
}

/**
 * Complete terminal input pipeline — mirrors TerminalPool.ts logic.
 *
 * Two modes:
 *   - "old": Pre-fix (commit 978cf69) — compositionend checks sentChars only
 *   - "new": The fix — compositionend checks textareaAccum, neutralizes event,
 *            tertiary guard in onData, dual-check in handleTerminalInput
 */
class TerminalInputPipeline {
  // ── State matching TerminalPool.ts PoolEntry ──
  sentChars = "";
  textareaAccum = "";

  // ── State matching TerminalPool.ts closure variables ──
  private lastSpuriousFlush: string | null = null;

  // ── Output tracking ──
  ptyWrites: string[] = [];

  constructor(private mode: "old" | "new") {}

  /**
   * Layer 1: compositionend capture-phase handler.
   *
   * Models: container.addEventListener("compositionend", ..., true)
   *
   * Returns: { neutralized: boolean, eventData: string }
   *   - neutralized=true means the event data was blanked (xterm gets "")
   *   - neutralized=false means the event passes through with original data
   */
  compositionEndHandler(composedData: string): { neutralized: boolean; eventData: string } {
    if (!composedData || composedData.length <= 1) {
      // Single-char or empty: always allow through (dead keys, real IME)
      return { neutralized: false, eventData: composedData };
    }

    if (this.mode === "old") {
      // OLD: check sentChars (resets on Enter/Ctrl-C — THE BUG)
      if (this.sentChars.length > 0 && this.sentChars.includes(composedData)) {
        // Old code just returns early — doesn't neutralize, doesn't set tertiary guard
        // The event still propagates to xterm's bubbling handler with full data
        return { neutralized: false, eventData: composedData };
      }
    } else {
      // NEW: check textareaAccum (NEVER cleared on Enter/Ctrl-C)
      const accum = this.textareaAccum;
      if (accum.length > 0 && (accum.includes(composedData) || composedData.endsWith(accum))) {
        // Neutralize event data via Object.defineProperty
        this.lastSpuriousFlush = composedData;
        return { neutralized: true, eventData: "" };
      }
    }

    // Not detected as spurious — allow through
    return { neutralized: false, eventData: composedData };
  }

  /**
   * xterm's bubbling-phase compositionend handler.
   *
   * In real xterm, this reads e.data and fires onData() with that value.
   * If we neutralized the data to "", xterm fires onData("") which is a no-op.
   */
  xtermBubblingHandler(eventData: string): string | null {
    if (!eventData) return null; // Empty data = no onData fired
    return eventData; // This becomes the onData payload
  }

  /**
   * Layer 2: Our onData handler (tertiary guard + forward to handleTerminalInput).
   *
   * Models: terminal.onData((data) => { ... })
   */
  onDataHandler(data: string): void {
    if (!data) return;

    // Tertiary guard (NEW only)
    if (this.mode === "new") {
      if (this.lastSpuriousFlush !== null && data.length > 1 && data === this.lastSpuriousFlush) {
        this.lastSpuriousFlush = null;
        return; // SUPPRESS
      }
    }

    this.handleTerminalInput(data);
  }

  /**
   * Layer 3: handleTerminalInput — dedup guard + writeToSession.
   *
   * Models: function handleTerminalInput(sessionId, data)
   */
  private handleTerminalInput(data: string): void {
    // ── Dedup guard ──
    if (data.length > 1) {
      const isEscapeSeq = data.charCodeAt(0) === 0x1b;
      const isBracketedPaste = data.includes("\x1b[200~");
      if (!isEscapeSeq && !isBracketedPaste) {
        let printable = "";
        for (let i = 0; i < data.length; i++) {
          if (data.charCodeAt(i) >= 32) printable += data[i];
        }
        if (printable.length > 1) {
          if (this.mode === "old") {
            // OLD: sentChars only
            if (this.sentChars.length > 0 && this.sentChars.includes(printable)) {
              return; // Suppress
            }
          } else {
            // NEW: textareaAccum primary, sentChars secondary
            const accum = this.textareaAccum;
            if (accum.length > 0 && (accum.includes(printable) || printable.endsWith(accum))) {
              return; // Suppress
            }
            if (this.sentChars.length > 0 && this.sentChars.includes(printable)) {
              return; // Suppress
            }
          }
        }
      }
    }

    // ── "writeToSession" — record what reaches the PTY ──
    this.ptyWrites.push(data);

    // ── Track sent characters ──
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === 0x0d || code === 0x03) {
        // Enter/Ctrl-C: sentChars resets, textareaAccum does NOT
        this.sentChars = "";
      } else if (code >= 32) {
        this.sentChars += data[i];
        if (this.sentChars.length > SENT_CHARS_MAX) {
          this.sentChars = this.sentChars.slice(-SENT_CHARS_MAX);
        }
        if (this.mode === "new") {
          this.textareaAccum += data[i];
          if (this.textareaAccum.length > TEXTAREA_ACCUM_MAX) {
            this.textareaAccum = this.textareaAccum.slice(-TEXTAREA_ACCUM_MAX);
          }
        }
      }
    }
  }

  // ── High-level simulation helpers ──

  /** Simulate a normal keypress: textarea accumulates, onData fires with single char */
  keypress(ch: string, textarea: XtermTextarea): void {
    textarea.append(ch);
    this.onDataHandler(ch);
  }

  /** Simulate typing a string character-by-character */
  typeString(str: string, textarea: XtermTextarea): void {
    for (const ch of str) {
      this.keypress(ch, textarea);
    }
  }

  /** Simulate Enter key */
  pressEnter(textarea: XtermTextarea): void {
    // Enter does NOT modify the textarea (control chars are ignored)
    this.onDataHandler("\r");
  }

  /** Simulate Ctrl-C */
  pressCtrlC(textarea: XtermTextarea): void {
    this.onDataHandler("\x03");
  }

  /**
   * Simulate WKWebView's spurious compositionend flush.
   *
   * This is the EXACT event sequence that causes the bug:
   *   1. WKWebView fires compositionend with textarea.value as data
   *   2. Our capture-phase handler runs (may neutralize)
   *   3. xterm's bubbling-phase handler runs (reads event data, fires onData)
   *   4. Our onData handler runs (tertiary guard, then handleTerminalInput)
   */
  triggerSpuriousFlush(textarea: XtermTextarea, runtime: WKWebViewRuntime): void {
    const composedData = runtime.fireSpuriousCompositionEnd(textarea);

    // Layer 1: our compositionend capture handler
    const result = this.compositionEndHandler(composedData);

    // xterm's bubbling handler processes the (possibly neutralized) event
    const onDataPayload = this.xtermBubblingHandler(result.eventData);

    // Layer 2+3: our onData handler → handleTerminalInput
    if (onDataPayload !== null) {
      this.onDataHandler(onDataPayload);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUG REPRODUCTION: Type → Enter → Type → Spurious Flush
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("BUG REPRODUCTION: Type, Enter, Type, Flush — the exact broken scenario", () => {
  it("OLD PIPELINE: flush after Enter reaches PTY — BUG CONFIRMED", () => {
    const pipeline = new TerminalInputPipeline("old");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    // User types "ls"
    pipeline.typeString("ls", textarea);
    expect(pipeline.ptyWrites).toEqual(["l", "s"]);
    expect(textarea.value).toBe("ls");

    // User presses Enter
    pipeline.pressEnter(textarea);
    expect(pipeline.ptyWrites).toEqual(["l", "s", "\r"]);
    // sentChars is now "" (reset on Enter), but textarea still has "ls"
    expect(pipeline.sentChars).toBe("");
    expect(textarea.value).toBe("ls"); // TEXTAREA PERSISTS

    // User types "echo hello"
    pipeline.typeString("echo hello", textarea);
    expect(textarea.value).toBe("lsecho hello"); // textarea accumulated EVERYTHING
    expect(pipeline.sentChars).toBe("echo hello"); // sentChars only has post-Enter

    // WKWebView fires spurious compositionend with "lsecho hello"
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // ═══ BUG: "lsecho hello" reached the PTY as a duplicate! ═══
    // Expected: only individual chars should reach PTY
    // Actual: the flush "lsecho hello" also reached PTY
    const lastWrite = pipeline.ptyWrites[pipeline.ptyWrites.length - 1];
    expect(lastWrite).toBe("lsecho hello"); // THE BUG: duplicate reached PTY!

    // Count: 2 ("ls") + 1 ("\r") + 10 ("echo hello") + 1 (flush) = 14 writes
    // The flush write is the duplicate that should NOT be there
    expect(pipeline.ptyWrites.length).toBe(14);
  });

  it("NEW PIPELINE: flush after Enter is suppressed — FIX CONFIRMED", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    // Same sequence: type "ls", Enter, type "echo hello"
    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hello", textarea);

    expect(textarea.value).toBe("lsecho hello"); // textarea accumulated EVERYTHING
    expect(pipeline.sentChars).toBe("echo hello"); // sentChars reset on Enter
    expect(pipeline.textareaAccum).toBe("lsecho hello"); // textareaAccum PERSISTS

    // WKWebView fires spurious compositionend with "lsecho hello"
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // ═══ FIX: flush was suppressed — did NOT reach PTY ═══
    // Only individual chars + Enter should be in PTY writes
    expect(pipeline.ptyWrites).toEqual([
      "l", "s", "\r",
      "e", "c", "h", "o", " ", "h", "e", "l", "l", "o",
    ]);

    // No extra write from the flush
    expect(pipeline.ptyWrites.length).toBe(13);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUG REPRODUCTION: Multiple commands — flush after N Enter presses
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("BUG REPRODUCTION: Multiple commands with Enter — increasingly large flushes", () => {
  it("OLD PIPELINE: flush grows with each command — all pass through", () => {
    const pipeline = new TerminalInputPipeline("old");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    // Command 1: "ls"
    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);

    // Command 2: "pwd"
    pipeline.typeString("pwd", textarea);
    pipeline.pressEnter(textarea);

    // Command 3: "echo hi"
    pipeline.typeString("echo hi", textarea);

    // Textarea has accumulated "lspwdecho hi" across all commands
    expect(textarea.value).toBe("lspwdecho hi");
    // sentChars only has "echo hi" (was reset twice by Enter)
    expect(pipeline.sentChars).toBe("echo hi");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // BUG: the flush "lspwdecho hi" was NOT suppressed
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore + 1);
    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("lspwdecho hi");
  });

  it("NEW PIPELINE: flush after multiple Enter presses — suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("pwd", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hi", textarea);

    expect(textarea.value).toBe("lspwdecho hi");
    expect(pipeline.textareaAccum).toBe("lspwdecho hi"); // MATCHES textarea

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // FIX: the flush was suppressed
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUG REPRODUCTION: Ctrl-C reset scenario
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("BUG REPRODUCTION: Flush after Ctrl-C", () => {
  it("OLD PIPELINE: flush after Ctrl-C passes through — BUG", () => {
    const pipeline = new TerminalInputPipeline("old");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("rm -rf /", textarea);
    pipeline.pressCtrlC(textarea); // Cancel! sentChars resets
    pipeline.typeString("ls", textarea);

    expect(textarea.value).toBe("rm -rf /ls");
    expect(pipeline.sentChars).toBe("ls"); // Only post-Ctrl-C

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // BUG: "rm -rf /ls" passed through because sentChars is only "ls"
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore + 1);
  });

  it("NEW PIPELINE: flush after Ctrl-C is suppressed — FIX", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("rm -rf /", textarea);
    pipeline.pressCtrlC(textarea);
    pipeline.typeString("ls", textarea);

    expect(pipeline.textareaAccum).toBe("rm -rf /ls"); // Persists!

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // FIX: suppressed
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUG REPRODUCTION: Mid-typing flush (within same prompt, no Enter)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("BUG REPRODUCTION: Mid-typing flush (no Enter yet) — both pipelines catch this", () => {
  it("OLD PIPELINE: mid-typing flush is suppressed (sentChars still has everything)", () => {
    const pipeline = new TerminalInputPipeline("old");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("This is a test", textarea);

    // sentChars still has everything (no Enter to reset it)
    expect(pipeline.sentChars).toBe("This is a test");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // Old code catches this case (sentChars hasn't been reset yet)
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });

  it("NEW PIPELINE: mid-typing flush is also suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("This is a test", textarea);

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SAFETY: things that must NOT be suppressed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SAFETY: Normal typing (single chars) always reaches PTY", () => {
  it("each keystroke reaches PTY exactly once in both pipelines", () => {
    for (const mode of ["old", "new"] as const) {
      const pipeline = new TerminalInputPipeline(mode);
      const textarea = new XtermTextarea();

      pipeline.typeString("hello", textarea);

      expect(pipeline.ptyWrites).toEqual(["h", "e", "l", "l", "o"]);
    }
  });
});

describe("SAFETY: Escape sequences pass through in new pipeline", () => {
  it("arrow keys are not suppressed even after typing", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("test", textarea);
    pipeline.onDataHandler("\x1b[A"); // Up arrow

    expect(pipeline.ptyWrites).toEqual(["t", "e", "s", "t", "\x1b[A"]);
  });
});

describe("SAFETY: Bracketed paste passes through in new pipeline", () => {
  it("paste content is not suppressed even if it matches accum", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);

    // Paste the same text (bracketed paste mode)
    pipeline.onDataHandler("\x1b[200~hello\x1b[201~");

    // Paste should be the 6th write (after h,e,l,l,o)
    expect(pipeline.ptyWrites.length).toBe(6);
    expect(pipeline.ptyWrites[5]).toBe("\x1b[200~hello\x1b[201~");
  });
});

describe("SAFETY: Real dead key composition (single char) passes through", () => {
  it("single-char compositionend is not treated as spurious", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("cafe", textarea);

    // Real dead key: ' + e = é (single char compositionend)
    const result = pipeline.compositionEndHandler("é");
    expect(result.neutralized).toBe(false);
    expect(result.eventData).toBe("é");
  });
});

describe("SAFETY: Real CJK IME composition passes through", () => {
  it("CJK chars are never in textareaAccum so they pass through", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);

    // CJK IME output (e.g., pinyin → 你好) — multi-char but not in accum
    const result = pipeline.compositionEndHandler("你好");
    expect(result.neutralized).toBe(false);
  });
});

describe("SAFETY: Genuinely new multi-char data passes through", () => {
  it("data never typed before is not suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);

    // Simulate some other multi-char data that isn't in the accum
    pipeline.onDataHandler("world");

    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("world");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THREE-LAYER DEFENSE verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("THREE-LAYER DEFENSE: each layer independently catches the flush", () => {
  it("Layer 1 (compositionend): neutralizes event data so xterm has nothing to flush", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hi", textarea);

    const result = pipeline.compositionEndHandler("lsecho hi");
    expect(result.neutralized).toBe(true);
    expect(result.eventData).toBe("");

    // xterm's handler receives "" → no onData fired → nothing reaches PTY
    const onDataPayload = pipeline.xtermBubblingHandler(result.eventData);
    expect(onDataPayload).toBeNull();
  });

  it("Layer 2 (tertiary guard): catches flush if Layer 1 neutralization failed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hi", textarea);

    // Simulate Layer 1 detecting spurious but failing to neutralize
    // (Object.defineProperty throws) — manually set lastSpuriousFlush
    const composed = "lsecho hi";
    // Call compositionEndHandler to set lastSpuriousFlush
    pipeline.compositionEndHandler(composed);
    // Simulate xterm's handler still firing with original data (neutralization "failed")
    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.onDataHandler(composed);

    // The tertiary guard should have caught it
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });

  it("Layer 3 (handleTerminalInput guard): catches flush if Layers 1+2 both missed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hi", textarea);

    // Skip Layer 1 and 2 entirely — call handleTerminalInput directly via onData
    // with no compositionend handler having run (simulates worst case)
    const writeCountBefore = pipeline.ptyWrites.length;

    // Bypass compositionEndHandler entirely, go straight to onData
    // lastSpuriousFlush is null, so tertiary guard won't help
    // But handleTerminalInput's dedup guard uses textareaAccum
    pipeline.onDataHandler("lsecho hi");

    // Layer 3 caught it
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REALISTIC SESSION: Long typing session with many commands
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("REALISTIC SESSION: 5-command terminal session", () => {
  it("OLD PIPELINE: random flush after 5th command duplicates entire history", () => {
    const pipeline = new TerminalInputPipeline("old");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    const commands = ["ls -la", "cd /tmp", "mkdir test", "cd test", "echo done"];

    for (const cmd of commands) {
      pipeline.typeString(cmd, textarea);
      if (cmd !== commands[commands.length - 1]) {
        pipeline.pressEnter(textarea);
      }
    }

    // Textarea has ALL text: "ls -lacd /tmpmkdir testcd testecho done"
    const expectedTextarea = commands.join("");
    expect(textarea.value).toBe(expectedTextarea);
    // sentChars only has "echo done"
    expect(pipeline.sentChars).toBe("echo done");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // BUG: entire history flushed to PTY
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore + 1);
    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe(expectedTextarea);
  });

  it("NEW PIPELINE: random flush after 5th command — suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    const commands = ["ls -la", "cd /tmp", "mkdir test", "cd test", "echo done"];

    for (const cmd of commands) {
      pipeline.typeString(cmd, textarea);
      if (cmd !== commands[commands.length - 1]) {
        pipeline.pressEnter(textarea);
      }
    }

    const expectedTextarea = commands.join("");
    expect(pipeline.textareaAccum).toBe(expectedTextarea);

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // FIX: flush suppressed
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Source-level verification (architectural invariants)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SOURCE: textareaAccum architecture", () => {
  it("PoolEntry declares textareaAccum: string", () => {
    expect(SRC).toMatch(/textareaAccum:\s*string/);
  });

  it("TEXTAREA_ACCUM_MAX = 2048", () => {
    expect(SRC).toMatch(/const TEXTAREA_ACCUM_MAX\s*=\s*2048/);
  });

  it("textareaAccum initialized to empty string", () => {
    const poolSetBlock = SRC.match(/pool\.set\(sessionId,\s*\{[\s\S]*?\}\)/);
    expect(poolSetBlock).not.toBeNull();
    expect(poolSetBlock![0]).toContain('textareaAccum: ""');
  });

  it("Enter/Ctrl-C resets sentChars but NOT textareaAccum", () => {
    const branch = SRC.match(
      /if \(code === 0x0d \|\| code === 0x03\) \{[\s\S]*?entry\.sentChars = "";\n\s*\}/
    );
    expect(branch).not.toBeNull();
    expect(branch![0]).not.toMatch(/textareaAccum\s*=/);
  });

  it("phase change resets sentChars but NOT textareaAccum", () => {
    const block = SRC.match(/if \(phase !== "idle" && phase !== "shell_ready"\)[\s\S]*?\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('entry.sentChars = ""');
    expect(block![0]).not.toContain("textareaAccum");
  });

  it("compositionend handler uses textareaAccum, not sentChars", () => {
    const handler = SRC.match(
      /container\.addEventListener\("compositionend"[\s\S]*?true\); \/\/ capture/
    );
    expect(handler).not.toBeNull();
    expect(handler![0]).toContain("entry.textareaAccum");
    expect(handler![0]).not.toContain("entry.sentChars");
  });

  it("compositionend neutralizes event data via Object.defineProperty", () => {
    expect(SRC).toContain('Object.defineProperty(e, "data", { value: "", configurable: true })');
  });

  it("tertiary guard in onData fires before handleTerminalInput", () => {
    const onData = SRC.match(
      /terminal\.onData\(\(data\)\s*=>\s*\{[\s\S]*?handleTerminalInput\(sessionId, data\)/
    );
    expect(onData).not.toBeNull();
    const guardIdx = onData![0].indexOf("lastSpuriousFlush !== null && data.length > 1 && data === lastSpuriousFlush");
    const handleIdx = onData![0].indexOf("handleTerminalInput(sessionId, data)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(handleIdx);
  });

  it("dedup guard uses textareaAccum as primary, sentChars as secondary", () => {
    const guard = SRC.match(
      /\/\/ ── Dedup guard: WKWebView composition flush ──[\s\S]*?\/\/ ── Always pass data to PTY/
    );
    expect(guard).not.toBeNull();
    const accumIdx = guard![0].indexOf("entry.textareaAccum");
    const sentIdx = guard![0].indexOf("entry.sentChars.length > 0 && entry.sentChars.includes");
    expect(accumIdx).toBeLessThan(sentIdx);
  });
});
