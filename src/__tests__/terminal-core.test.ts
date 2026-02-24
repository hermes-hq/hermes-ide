/**
 * Terminal Core Stabilization — Forensic Invariant Tests
 *
 * These tests enforce the HARD INVARIANTS of the terminal input pipeline.
 * They verify the architecture by reading source code, not by mocking xterm.
 *
 * Bug 1: Apostrophe duplication — WKWebView fires onData twice per keystroke
 *         Fix: attachCustomKeyEventHandler suppresses keydown for printable chars
 * Bug 2: Cmd+Click links — WKWebView blocks window.open()
 * Bug 3: Scroll jumping — auto-scroll during streaming
 * Bug 4: Shortcut newline — terminal.paste() instead of control codes
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const SRC: string = readFileSync(
  new URL("../terminal/TerminalPool.ts", import.meta.url),
  "utf-8",
);

const PROVIDER_ACTIONS: string = readFileSync(
  new URL("../components/ProviderActionsBar.tsx", import.meta.url),
  "utf-8",
);

const CONTEXT_PANEL: string = readFileSync(
  new URL("../components/ContextPanel.tsx", import.meta.url),
  "utf-8",
);

const TERMINAL_PANE: string = readFileSync(
  new URL("../components/TerminalPane.tsx", import.meta.url),
  "utf-8",
);

const APP: string = readFileSync(
  new URL("../App.tsx", import.meta.url),
  "utf-8",
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 1: Single authoritative input path — no dual echo
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 1: ONE authoritative input path, no dual echo", () => {
  it("no active onBinary handler (was dual-fire source)", () => {
    const lines = SRC.split("\n");
    const active = lines.filter((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return t.includes(".onBinary(");
    });
    expect(active).toHaveLength(0);
  });

  it("onData is the single input entry point", () => {
    const onDataRegistrations = SRC.match(/terminal\.onData\(/g);
    expect(onDataRegistrations).not.toBeNull();
    expect(onDataRegistrations!.length).toBe(1); // exactly ONE registration
  });

  it("onData handler calls handleTerminalInput (not writeToSession directly)", () => {
    const match = SRC.match(/terminal\.onData\(\(data\)\s*=>\s*\{[\s\S]*?handleTerminalInput/);
    expect(match).not.toBeNull();
  });

  it("no terminal.write() for user input — only PTY output", () => {
    // terminal.write() should ONLY appear in:
    //   1. pty-output event handler
    //   2. pty-exit message
    //   3. writeScrollback
    //   4. sendShortcutCommand backspace clearing
    // NOT in handleTerminalInput or onData
    const handleInputFn = SRC.match(
      /function handleTerminalInput[\s\S]*?^}/m
    );
    if (handleInputFn) {
      expect(handleInputFn[0]).not.toContain("terminal.write(");
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 2: attachCustomKeyEventHandler prevents double onData
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 2: attachCustomKeyEventHandler eliminates duplicate onData", () => {
  it("attachCustomKeyEventHandler is registered", () => {
    expect(SRC).toContain("terminal.attachCustomKeyEventHandler(");
  });

  it("suppresses keydown for non-passthrough keys (KEYDOWN_PASSTHROUGH allowlist)", () => {
    // The main suppression logic must use an allowlist to decide what goes through keydown
    expect(SRC).toContain("KEYDOWN_PASSTHROUGH.has(event.key)");
    // The shouldSuppress variable must NOT use key-length as the primary check
    const suppressBlock = SRC.match(/const shouldSuppress\s*=[\s\S]*?;/);
    expect(suppressBlock).not.toBeNull();
    expect(suppressBlock![0]).not.toContain("event.key.length");
    expect(suppressBlock![0]).toContain("KEYDOWN_PASSTHROUGH");
  });

  it("allows modifier combos through (Ctrl, Meta, Alt)", () => {
    expect(SRC).toContain("event.ctrlKey");
    expect(SRC).toContain("event.metaKey");
    expect(SRC).toContain("event.altKey");
  });

  it("allows composing (IME) events through", () => {
    expect(SRC).toContain("event.isComposing");
  });

  it("only intercepts keydown, not keyup", () => {
    expect(SRC).toMatch(/event\.type !== "keydown"/);
  });

  it("returns false for printable keydown (suppress) — the key architectural decision", () => {
    // The handler must return false to suppress printable keydown
    // This means only textarea input events fire onData for printable chars
    // The handler block ends with `if (shouldSuppress) return false;`
    expect(SRC).toContain("if (shouldSuppress) return false;");
  });

  it("NO timing-based dedup exists (removed architectural hack)", () => {
    // These must NOT exist anywhere in the source
    expect(SRC).not.toContain("_lastOnDataValue");
    expect(SRC).not.toContain("_lastOnDataTime");
    expect(SRC).not.toMatch(/now - _lastOnData/);
    expect(SRC).not.toMatch(/< 10/); // No 10ms window
  });

  it("NO heuristic-based dedup exists (composition dedup is allowed)", () => {
    // No TIMING heuristics in onData
    const onDataBlock = SRC.match(/terminal\.onData\(\(data\)\s*=>\s*\{[\s\S]*?\}\);/);
    expect(onDataBlock).not.toBeNull();
    // Must not have timing-based dedup
    expect(onDataBlock![0]).not.toContain("performance.now()");
    // Composition-based dedup (lastComposedChar) is allowed — it uses
    // compositionend events, not timing heuristics
    expect(onDataBlock![0]).toContain("lastComposedChar");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 3: Shortcut uses terminal.paste() — no control codes for text
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 3: Shortcut command uses triggerDataEvent with backspace clearing, no breaking codes", () => {
  // Extract the sendShortcutCommand function body
  function getShortcutFnBody(): string {
    const match = SRC.match(
      /export function sendShortcutCommand\([\s\S]*?\n\}/
    );
    expect(match).not.toBeNull();
    return match![0];
  }

  it("sendShortcutCommand is exported", () => {
    expect(SRC).toMatch(/export function sendShortcutCommand\(/);
  });

  it("uses triggerDataEvent for command injection (with writeToSession fallback)", () => {
    const body = getShortcutFnBody();
    expect(body).toContain("triggerDataEvent");
    // writeToSession is used as a fallback when triggerDataEvent is not available
    expect(body).toContain("writeToSession");
  });

  it("uses backspaces to clear existing input before sending command", () => {
    const body = getShortcutFnBody();
    // Uses \x7f (DEL/backspace) repeated by eraseLen to clear existing text
    expect(body).toContain("\\x7f");
    expect(body).toContain("eraseLen");
  });

  it("does NOT contain \\x0b (Vertical Tab — causes cursor-down in display)", () => {
    const body = getShortcutFnBody();
    expect(body).not.toContain("\\x0b");
  });

  it("validates command has no line breaks (invariant enforcement)", () => {
    const body = getShortcutFnBody();
    // Source should check for \n and \r in command
    expect(body).toContain('command.includes("\\n")');
    expect(body).toContain('command.includes("\\r")');
  });

  it("clears inputBuffer and dismisses suggestions", () => {
    const body = getShortcutFnBody();
    expect(body).toContain('entry.inputBuffer = ""');
    expect(body).toContain("dismissSuggestions");
  });

  it("does NOT append Enter — user reviews and presses Enter manually", () => {
    const body = getShortcutFnBody();
    // The command is inserted on the prompt, not executed
    expect(body).toContain("NO \\r");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 4: All callers use sendShortcutCommand (no raw writeToSession)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 4: All UI shortcut callers use sendShortcutCommand", () => {
  it("ProviderActionsBar uses sendShortcutCommand, not writeToSession", () => {
    expect(PROVIDER_ACTIONS).toContain("sendShortcutCommand");
    expect(PROVIDER_ACTIONS).not.toContain("writeToSession");
  });

  it("ContextPanel uses sendShortcutCommand", () => {
    expect(CONTEXT_PANEL).toContain("sendShortcutCommand");
  });

  it("TerminalPane annotation apply uses sendShortcutCommand", () => {
    expect(TERMINAL_PANE).toContain("sendShortcutCommand");
  });

  it("App auto-execute uses sendShortcutCommand", () => {
    expect(APP).toContain("sendShortcutCommand");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 5: Input buffer handles multi-char data correctly
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 5: updateInputBuffer handles paste/IME (multi-char data)", () => {
  /** Mirror of updateInputBuffer logic for unit testing.
   *  Must match the actual implementation in TerminalPool.ts exactly. */
  function updateInputBuffer(inputBuffer: string, data: string): string {
    // Single-char fast path
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code === 0x7f) return inputBuffer.slice(0, -1);
      if (code === 0x03 || code === 0x15) return "";
      if (code === 0x0d) return ""; // Enter clears
      if (code === 0x1b) return inputBuffer; // Bare Escape
      if (code >= 32) return inputBuffer + data;
      return inputBuffer;
    }
    // Escape sequences
    if (data.startsWith("\x1b")) return inputBuffer;
    // Multi-char: process every character (paste, IME, shortcut payload)
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === 0x7f) {
        inputBuffer = inputBuffer.slice(0, -1);
      } else if (code === 0x03 || code === 0x15 || code === 0x0d) {
        inputBuffer = "";
      } else if (code === 0x1b) {
        break; // escape sequence — stop processing
      } else if (code >= 32) {
        inputBuffer += data[i];
      }
    }
    return inputBuffer;
  }

  it("single apostrophe → exactly one char in buffer", () => {
    expect(updateInputBuffer("don", "'")).toBe("don'");
  });

  it("typing \"doesn't\" produces exactly 7 chars", () => {
    let buf = "";
    for (const ch of "doesn't") {
      buf = updateInputBuffer(buf, ch);
    }
    expect(buf).toBe("doesn't");
    expect(buf.length).toBe(7);
  });

  it("typing \"'t\" produces exactly 2 chars (no drops)", () => {
    let buf = "";
    buf = updateInputBuffer(buf, "'");
    buf = updateInputBuffer(buf, "t");
    expect(buf).toBe("'t");
    expect(buf.length).toBe(2);
  });

  it("curly quotes → tracked correctly", () => {
    expect(updateInputBuffer("", "\u2018\u2019")).toBe("\u2018\u2019");
  });

  it("paste of multiple chars → all appended", () => {
    expect(updateInputBuffer("", "hello world")).toBe("hello world");
  });

  it("control chars in paste data → filtered out", () => {
    expect(updateInputBuffer("", "a\x01b\x02c")).toBe("abc");
  });

  it("backspace removes exactly one char", () => {
    expect(updateInputBuffer("abc", "\x7f")).toBe("ab");
  });

  it("Enter within paste clears buffer (shortcut payload correctness)", () => {
    // Simulates: paste("\x15/config\r") → Ctrl-U clears, then /config typed, then Enter clears
    expect(updateInputBuffer("stale", "\x15/config\r")).toBe("");
  });

  it("Ctrl-U within paste clears buffer before remaining chars", () => {
    expect(updateInputBuffer("old", "\x15new")).toBe("new");
  });

  it("shortcut payload with Ctrl-U + command + Enter leaves buffer empty", () => {
    // Legacy payload pattern — tests that control chars reset the buffer
    const payload = "\x15/compact\r";
    expect(updateInputBuffer("whatever", payload)).toBe("");
  });

  it("source does NOT use single-char guard (old bug pattern)", () => {
    expect(SRC).not.toMatch(/data\.length === 1 && data\.charCodeAt\(0\) >= 32[\s\S]*?entry\.inputBuffer \+= data/);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 6: WebLinksAddon uses Tauri shell open, not window.open()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 6: Links open via Tauri shell (not blocked window.open)", () => {
  it("imports open from @tauri-apps/plugin-shell", () => {
    expect(SRC).toContain('from "@tauri-apps/plugin-shell"');
  });

  it("WebLinksAddon has custom handler (no default constructor)", () => {
    expect(SRC).not.toMatch(/new WebLinksAddon\(\)/);
    expect(SRC).toMatch(/new WebLinksAddon\(\(_event, uri\)/);
  });

  it("handler calls shellOpen(uri)", () => {
    expect(SRC).toMatch(/shellOpen\(uri\)/);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 7: Scroll position preserved during streaming
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 7: Scroll tracking prevents jump during streaming", () => {
  it("PoolEntry has userScrolledUp flag", () => {
    expect(SRC).toMatch(/userScrolledUp:\s*boolean/);
  });

  it("onScroll detects at-bottom vs scrolled-up", () => {
    expect(SRC).toContain("terminal.onScroll(");
    expect(SRC).toContain("buf.baseY + terminal.rows >= buf.length");
  });

  it("PTY output handler preserves viewport when scrolled up", () => {
    expect(SRC).toContain("entry?.userScrolledUp");
    expect(SRC).toContain("scrollToLine(viewportY)");
  });

  it("refitActive only scrolls to bottom when at bottom", () => {
    const refitBody = SRC.match(/export function refitActive[\s\S]*?\n\}/);
    expect(refitBody).not.toBeNull();
    expect(refitBody![0]).toContain("if (!entry.userScrolledUp)");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 8: No dangerous control codes in the codebase
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 8: No accidental display-breaking codes sent to PTY", () => {
  it("\\x0b (Vertical Tab) never appears in shortcut/command sending code", () => {
    const shortcutFn = SRC.match(/export function sendShortcutCommand[\s\S]*?\n\}/);
    expect(shortcutFn).not.toBeNull();
    expect(shortcutFn![0]).not.toContain("\\x0b");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 9: Context lifecycle guards prevent double injection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONTEXT_HOOK: string = readFileSync(
  new URL("../hooks/useContextState.ts", import.meta.url),
  "utf-8",
);

describe("Invariant 9: Context injection race prevention", () => {
  it("applyContext updates lifecycleRef SYNCHRONOUSLY before async work", () => {
    // The ref must be set to 'applying' BEFORE setLifecycle (which is async React state)
    const applyBlock = CONTEXT_HOOK.match(/const applyContext = useCallback[\s\S]*?}, \[/);
    expect(applyBlock).not.toBeNull();
    const body = applyBlock![0];
    // lifecycleRef.current = 'applying' must appear BEFORE setLifecycle('applying')
    const refSetIdx = body.indexOf("lifecycleRef.current = 'applying'");
    const stateSetIdx = body.indexOf("setLifecycle('applying')");
    expect(refSetIdx).toBeGreaterThan(-1);
    expect(stateSetIdx).toBeGreaterThan(-1);
    expect(refSetIdx).toBeLessThan(stateSetIdx);
  });

  it("project listener is gated by initialLoadDone", () => {
    expect(CONTEXT_HOOK).toMatch(/session-realms-updated[\s\S]*?initialLoadDone\.current/);
  });

  it("pin listener is gated by initialLoadDone", () => {
    expect(CONTEXT_HOOK).toMatch(/context-pins-changed[\s\S]*?initialLoadDone\.current/);
  });

  it("session sync effect is gated by initialLoadDone", () => {
    expect(CONTEXT_HOOK).toMatch(/session\.working_directory[\s\S]*?initialLoadDone\.current/);
  });

  it("prevContextRef initialized to emptyContext (not null)", () => {
    expect(CONTEXT_HOOK).toMatch(/prevContextRef = useRef<ContextState>\(emptyContext\(\)\)/);
  });

  it("initial load sets prevContextRef BEFORE setContext", () => {
    // Find the load function and verify ordering
    const loadBlock = CONTEXT_HOOK.match(/const load = async \(\)[\s\S]*?load\(\)/);
    expect(loadBlock).not.toBeNull();
    const body = loadBlock![0];
    const refSetIdx = body.indexOf("prevContextRef.current = structuralClone(initial)");
    const setContextIdx = body.indexOf("setContext(initial)");
    expect(refSetIdx).toBeGreaterThan(-1);
    expect(setContextIdx).toBeGreaterThan(-1);
    expect(refSetIdx).toBeLessThan(setContextIdx);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 10: sendShortcutCommand hard-stops on invariant violation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 10: sendShortcutCommand refuses linebreak commands", () => {
  it("returns after detecting linebreak (not just logs)", () => {
    const fnBody = SRC.match(/export function sendShortcutCommand[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // After the invariant check, there must be a return statement
    const checkIdx = body.indexOf('command.includes("\\n")');
    expect(checkIdx).toBeGreaterThan(-1);
    // Find the next 'return' after the check
    const afterCheck = body.slice(checkIdx);
    const returnIdx = afterCheck.indexOf("return;");
    expect(returnIdx).toBeGreaterThan(-1);
    // The return must be before the triggerDataEvent call
    const triggerIdx = afterCheck.indexOf("triggerDataEvent");
    expect(returnIdx).toBeLessThan(triggerIdx);
  });
});
