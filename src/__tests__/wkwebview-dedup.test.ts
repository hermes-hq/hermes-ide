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
 *      handler (Layer 1 defense). Old: sentChars check. New: textarea clear
 *      + flag-based suppression.
 *
 *   4. OnDataHandler — models our onData handler including the flag-based
 *      guard (Layer 2 defense).
 *
 *   5. HandleTerminalInput — models the dedup guard + writeToSession call
 *      (Layer 3 defense). Two versions: old (sentChars only) and new
 *      (textareaAccum exact match + sentChars exact match).
 *
 * We wire these together into two complete pipelines:
 *   - OldPipeline: pre-fix logic (commit 978cf69)
 *   - NewPipeline: the nuclear fix (textarea clear + flag + exact match)
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
 * actions like blur or Enter/Ctrl-C keydown (unreliable on WKWebView).
 */
class XtermTextarea {
  value = "";

  /** Append a character (models textarea 'input' event) */
  append(ch: string): void {
    if (ch.charCodeAt(0) >= 32) {
      this.value += ch;
    }
    // Control chars (Enter, Ctrl-C) do NOT clear the textarea.
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
 *   - "new": Nuclear fix — compositionend clears textarea + sets flag,
 *            flag-based Layer 2, exact-match-only Layer 3
 */
class TerminalInputPipeline {
  // ── State matching TerminalPool.ts PoolEntry ──
  sentChars = "";
  textareaAccum = "";

  // ── State matching TerminalPool.ts closure variables ──
  private suppressNextFlush = false;

  // ── Output tracking ──
  ptyWrites: string[] = [];

  constructor(private mode: "old" | "new") {}

  /**
   * Layer 1: compositionend capture-phase handler.
   *
   * Models: container.addEventListener("compositionend", ..., true)
   *
   * In "new" mode: clears textarea, resets accum, sets suppressNextFlush flag.
   * Returns: whether the spurious flush was detected.
   */
  compositionEndHandler(composedData: string, textarea?: XtermTextarea): boolean {
    if (!composedData || composedData.length <= 1) {
      return false; // Single-char or empty: always allow through
    }

    if (this.mode === "old") {
      // OLD: check sentChars (resets on Enter/Ctrl-C — THE BUG)
      if (this.sentChars.length > 0 && this.sentChars.includes(composedData)) {
        return true; // Detected but no effective suppression mechanism
      }
      return false;
    } else {
      // NEW: check textareaAccum with lenient detection (includes)
      const accum = this.textareaAccum;
      const isSpurious = accum.length > 0 && (
        accum === composedData ||
        accum.endsWith(composedData) || composedData.endsWith(accum) ||
        accum.includes(composedData) || composedData.includes(accum)
      );
      if (isSpurious) {
        // NUCLEAR: clear xterm's textarea so _finalizeComposition reads ""
        if (textarea) {
          textarea.value = "";
        }
        // Reset tracking to stay in sync
        this.textareaAccum = "";
        this.sentChars = "";
        // Set flag for Layer 2
        this.suppressNextFlush = true;
        return true;
      }
      return false;
    }
  }

  /**
   * xterm's bubbling-phase compositionend handler.
   *
   * In real xterm, _finalizeComposition reads textarea.value.substring(start)
   * via setTimeout(0). If we cleared the textarea in Layer 1, this reads "".
   */
  xtermBubblingHandler(textarea: XtermTextarea, compositionStart: number): string | null {
    const input = textarea.value.substring(compositionStart);
    if (!input) return null;
    return input;
  }

  /**
   * Layer 2: Our onData handler (flag-based guard + forward to handleTerminalInput).
   */
  onDataHandler(data: string): void {
    if (!data) return;

    // Flag-based guard (NEW only): suppress next multi-char non-escape non-paste
    if (this.mode === "new" && this.suppressNextFlush && data.length > 1) {
      const isEsc = data.charCodeAt(0) === 0x1b;
      const isPaste = data.includes("\x1b[200~");
      if (!isEsc && !isPaste) {
        this.suppressNextFlush = false;
        return; // SUPPRESS
      }
    }

    this.handleTerminalInput(data);
  }

  /**
   * Layer 3: handleTerminalInput — exact-match dedup guard + writeToSession.
   */
  private handleTerminalInput(data: string): void {
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
            // OLD: sentChars only (includes matching)
            if (this.sentChars.length > 0 && this.sentChars.includes(printable)) {
              return;
            }
          } else {
            // NEW: exact match only (no suffix matching — prevents false positives)
            if (this.textareaAccum.length > 0 && this.textareaAccum === printable) {
              return;
            }
            if (this.sentChars.length > 0 && this.sentChars === printable) {
              return;
            }
          }
        }
      }
    }

    // "writeToSession" — record what reaches the PTY
    this.ptyWrites.push(data);

    // Track sent characters
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === 0x0d || code === 0x03) {
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
    this.onDataHandler("\r");
  }

  /** Simulate Ctrl-C */
  pressCtrlC(textarea: XtermTextarea): void {
    this.onDataHandler("\x03");
  }

  /**
   * Simulate WKWebView's spurious compositionend flush.
   *
   * Models the EXACT event sequence:
   *   1. WKWebView fires compositionstart (records textarea position)
   *   2. WKWebView fires compositionend with textarea.value as data
   *   3. Our capture-phase handler runs (Layer 1: clears textarea + sets flag)
   *   4. xterm's _finalizeComposition runs via setTimeout(0):
   *      reads textarea.value.substring(compositionStart)
   *   5. If textarea was cleared, reads "" and sends nothing
   *   6. If somehow data still arrives, our onData handler catches it (Layer 2)
   */
  triggerSpuriousFlush(textarea: XtermTextarea, runtime: WKWebViewRuntime): void {
    const composedData = runtime.fireSpuriousCompositionEnd(textarea);

    // Record composition start position (what xterm does on compositionstart)
    const compositionStart = 0; // Spurious: often starts at 0 or an earlier position

    // Layer 1: our compositionend capture handler
    this.compositionEndHandler(composedData, textarea);

    // xterm's _finalizeComposition: reads from textarea (now cleared in "new" mode)
    const onDataPayload = this.xtermBubblingHandler(textarea, compositionStart);

    // Layer 2+3: our onData handler
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

    pipeline.typeString("ls", textarea);
    expect(pipeline.ptyWrites).toEqual(["l", "s"]);
    expect(textarea.value).toBe("ls");

    pipeline.pressEnter(textarea);
    expect(pipeline.ptyWrites).toEqual(["l", "s", "\r"]);
    expect(pipeline.sentChars).toBe("");
    expect(textarea.value).toBe("ls"); // TEXTAREA PERSISTS

    pipeline.typeString("echo hello", textarea);
    expect(textarea.value).toBe("lsecho hello");
    expect(pipeline.sentChars).toBe("echo hello");

    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // BUG: "lsecho hello" reached the PTY as a duplicate
    const lastWrite = pipeline.ptyWrites[pipeline.ptyWrites.length - 1];
    expect(lastWrite).toBe("lsecho hello");
    expect(pipeline.ptyWrites.length).toBe(14);
  });

  it("NEW PIPELINE: flush after Enter is suppressed — FIX CONFIRMED", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hello", textarea);

    expect(textarea.value).toBe("lsecho hello");
    expect(pipeline.textareaAccum).toBe("lsecho hello");

    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    // FIX: flush was suppressed — Layer 1 cleared textarea, nothing to send
    expect(pipeline.ptyWrites).toEqual([
      "l", "s", "\r",
      "e", "c", "h", "o", " ", "h", "e", "l", "l", "o",
    ]);
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

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("pwd", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hi", textarea);

    expect(textarea.value).toBe("lspwdecho hi");
    expect(pipeline.sentChars).toBe("echo hi");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

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
    expect(pipeline.textareaAccum).toBe("lspwdecho hi");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

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
    pipeline.pressCtrlC(textarea);
    pipeline.typeString("ls", textarea);

    expect(textarea.value).toBe("rm -rf /ls");
    expect(pipeline.sentChars).toBe("ls");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

    expect(pipeline.ptyWrites.length).toBe(writeCountBefore + 1);
  });

  it("NEW PIPELINE: flush after Ctrl-C is suppressed — FIX", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();
    const wkwebview = new WKWebViewRuntime();

    pipeline.typeString("rm -rf /", textarea);
    pipeline.pressCtrlC(textarea);
    pipeline.typeString("ls", textarea);

    expect(pipeline.textareaAccum).toBe("rm -rf /ls");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

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
    expect(pipeline.sentChars).toBe("This is a test");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

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

    expect(pipeline.ptyWrites.length).toBe(6);
    expect(pipeline.ptyWrites[5]).toBe("\x1b[200~hello\x1b[201~");
  });
});

describe("SAFETY: Real dead key composition (single char) passes through", () => {
  it("single-char compositionend is not treated as spurious", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("cafe", textarea);

    const detected = pipeline.compositionEndHandler("é", textarea);
    expect(detected).toBe(false);
  });
});

describe("SAFETY: Real CJK IME composition passes through", () => {
  it("CJK chars are never in textareaAccum so they pass through", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);

    const detected = pipeline.compositionEndHandler("你好", textarea);
    expect(detected).toBe(false);
  });
});

describe("SAFETY: Genuinely new multi-char data passes through", () => {
  it("data never typed before is not suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);
    pipeline.onDataHandler("world");

    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("world");
  });
});

describe("SAFETY: Fast typing 2-char batch is NOT suppressed", () => {
  it("typing 'testing' then fast-typing 'in' as a multi-char batch is not suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("testing", textarea);
    expect(pipeline.ptyWrites).toEqual(["t", "e", "s", "t", "i", "n", "g"]);

    pipeline.onDataHandler("in");

    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("in");
    expect(pipeline.ptyWrites.length).toBe(8);
  });

  it("typing 'hello' then fast-typing 'lo' as a multi-char batch is not suppressed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("hello", textarea);
    pipeline.onDataHandler("lo");

    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("lo");
    expect(pipeline.ptyWrites.length).toBe(6);
  });
});

describe("SAFETY: Paste ending with same text as accum is NOT suppressed", () => {
  it("pasting 'aatest' when accum is 'test' passes through (no endsWith false positive)", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("test", textarea);
    // Non-bracketed paste (e.g., from triggerDataEvent) that ends with "test"
    pipeline.onDataHandler("aatest");

    // Must NOT be suppressed — "aatest" !== "test" (exact match fails)
    expect(pipeline.ptyWrites[pipeline.ptyWrites.length - 1]).toBe("aatest");
    expect(pipeline.ptyWrites.length).toBe(5); // t,e,s,t + aatest
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NUCLEAR FIX: textarea clearing verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("NUCLEAR FIX: textarea clearing kills the flush at the source", () => {
  it("Layer 1 clears textarea — xterm's _finalizeComposition reads empty string", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("ls", textarea);
    pipeline.pressEnter(textarea);
    pipeline.typeString("echo hello", textarea);
    expect(textarea.value).toBe("lsecho hello");

    // Layer 1: detect spurious and clear textarea
    const detected = pipeline.compositionEndHandler("lsecho hello", textarea);
    expect(detected).toBe(true);

    // Textarea was CLEARED by Layer 1
    expect(textarea.value).toBe("");

    // xterm's _finalizeComposition reads empty string
    const onDataPayload = pipeline.xtermBubblingHandler(textarea, 0);
    expect(onDataPayload).toBeNull(); // Nothing to send!
  });

  it("Layer 2 flag catches data even if textarea clear somehow failed", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("test data", textarea);

    // Simulate: Layer 1 detected spurious, set flag, but textarea wasn't cleared
    // (e.g., xterm cached the value before our handler ran)
    pipeline.compositionEndHandler("test data", textarea);
    // Restore textarea value to simulate cache scenario
    textarea.value = "test data";

    const writeCountBefore = pipeline.ptyWrites.length;
    // Data arrives through onData with full cached content
    pipeline.onDataHandler("test data");

    // Layer 2 (flag) suppressed it
    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });

  it("accum and sentChars are reset after spurious detection — future typing works", () => {
    const pipeline = new TerminalInputPipeline("new");
    const textarea = new XtermTextarea();

    pipeline.typeString("ls", textarea);
    expect(pipeline.textareaAccum).toBe("ls");

    // Spurious flush detected — accum and sentChars reset
    pipeline.compositionEndHandler("ls", textarea);
    expect(pipeline.textareaAccum).toBe("");
    expect(pipeline.sentChars).toBe("");
    expect(textarea.value).toBe("");

    // User continues typing — works normally
    pipeline.typeString("pwd", textarea);
    expect(pipeline.textareaAccum).toBe("pwd");
    expect(textarea.value).toBe("pwd");
    expect(pipeline.ptyWrites.filter(w => w.length === 1 && w >= " ")).toEqual(
      ["l", "s", "p", "w", "d"]
    );
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

    const expectedTextarea = commands.join("");
    expect(textarea.value).toBe(expectedTextarea);
    expect(pipeline.sentChars).toBe("echo done");

    const writeCountBefore = pipeline.ptyWrites.length;
    pipeline.triggerSpuriousFlush(textarea, wkwebview);

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

    expect(pipeline.ptyWrites.length).toBe(writeCountBefore);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Source-level verification (architectural invariants)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("SOURCE: nuclear fix architecture", () => {
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

  it("compositionend handler clears xterm textarea on spurious detection", () => {
    const handler = SRC.match(
      /container\.addEventListener\("compositionend"[\s\S]*?true\); \/\/ capture/
    );
    expect(handler).not.toBeNull();
    expect(handler![0]).toContain('textarea.value = ""');
    expect(handler![0]).toContain('entry.textareaAccum = ""');
  });

  it("compositionend does NOT use Object.defineProperty", () => {
    expect(SRC).not.toContain('Object.defineProperty(e, "data"');
  });

  it("flag-based guard in onData fires before handleTerminalInput", () => {
    const onData = SRC.match(
      /terminal\.onData\(\(data\)\s*=>\s*\{[\s\S]*?handleTerminalInput\(sessionId, data\)/
    );
    expect(onData).not.toBeNull();
    const guardIdx = onData![0].indexOf("suppressNextFlush");
    const handleIdx = onData![0].indexOf("handleTerminalInput(sessionId, data)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(handleIdx);
  });

  it("Layer 3 dedup uses exact match only (no endsWith in executable code)", () => {
    const guard = SRC.match(
      /\/\/ ── Dedup guard \(Layer 3\)[\s\S]*?\/\/ ── Always pass data to PTY/
    );
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("entry.textareaAccum");
    // Strip comments to check only executable code
    const codeOnly = guard![0].replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toContain("endsWith");
  });

  it("sendShortcutCommand resets textareaAccum to prevent false suppression", () => {
    const fn = SRC.match(
      /export function sendShortcutCommand[\s\S]*?focusTerminal\(sessionId\)/
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('entry.textareaAccum = ""');
  });
});
