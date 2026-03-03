/**
 * Playwright WebKit tests for WKWebView composition fix.
 *
 * These tests run in the REAL WebKit engine — the same engine used by
 * Tauri's WKWebView on macOS. If tests pass here, the fix works in Tauri.
 */
import { test, expect, type Page } from "@playwright/test";

let page: Page;

test.beforeEach(async ({ page: p }) => {
  page = p;
  await page.goto("http://localhost:1422");
  // xterm textarea is hidden (position:absolute, opacity:0) — wait for attached
  await page.waitForSelector(".xterm-helper-textarea", { state: "attached" });
  // Focus textarea via JS (Playwright's focus() requires visibility)
  await page.evaluate(() => {
    (document.querySelector(".xterm-helper-textarea") as HTMLElement)?.focus();
  });
  // Clear buffer
  await page.evaluate(() => {
    (window as any).__terminalBuffer = [];
  });
});

// ── Helper: simulate a dead key composition sequence ──

async function simulateDeadKeyComposition(
  p: Page,
  pendingChar: string,
  resolvedChar: string,
): Promise<void> {
  await p.evaluate(
    ({ pending, resolved }) => {
      const ta = document.querySelector(".xterm-helper-textarea")!;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: pending, bubbles: true }));
      ta.dispatchEvent(
        new InputEvent("input", {
          data: pending,
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          code: "Quote",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: resolved, bubbles: true }));
    },
    { pending: pendingChar, resolved: resolvedChar },
  );
}

async function simulateNonCombiningDeadKey(
  p: Page,
  pendingChar: string,
  resolvedChar: string,
  trailingChar: string,
): Promise<void> {
  await p.evaluate(
    ({ pending, resolved, trailing }) => {
      const ta = document.querySelector(".xterm-helper-textarea")!;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: pending, bubbles: true }));
      ta.dispatchEvent(
        new InputEvent("input", {
          data: pending,
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          code: "Quote",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: resolved, bubbles: true }));
      // Trailing character fires AFTER compositionend
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: trailing,
          code: `Key${trailing.toUpperCase()}`,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new InputEvent("input", {
          data: trailing,
          inputType: "insertText",
          bubbles: true,
        }),
      );
    },
    { pending: pendingChar, resolved: resolvedChar, trailing: trailingChar },
  );
}

function getBuffer(p: Page): Promise<string> {
  return p.evaluate(() => (window as any).__terminalBuffer.join(""));
}

function getBufferArray(p: Page): Promise<string[]> {
  return p.evaluate(() => [...(window as any).__terminalBuffer]);
}

// ── Tests ──

test.describe("WKWebView composition fix (WebKit)", () => {
  test("hello world — regular ASCII typing", async () => {
    // Use page.keyboard (not locator) since xterm textarea is hidden
    await page.keyboard.type("hello world", { delay: 30 });
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("hello world");
  });

  test("don't — character after non-combining dead key is not lost", async () => {
    await page.keyboard.type("don", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateNonCombiningDeadKey(page, "'", "'", "t");
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("don't");
  });

  test("cafe with acute e — combining dead key", async () => {
    await page.keyboard.type("caf", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "'", "é");
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("café");
  });

  test("tilde a — combining dead key produces ã", async () => {
    await page.keyboard.type("c", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "˜", "ã");
    await page.waitForTimeout(50);

    await page.keyboard.type("o", { delay: 30 });
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("cão");
  });

  test("Enter after composition works", async () => {
    await simulateDeadKeyComposition(page, "'", "é");
    await page.waitForTimeout(50);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);

    const arr = await getBufferArray(page);
    expect(arr[0]).toBe("é");
    expect(arr[1]).toBe("\r");
  });

  test("Backspace after composition works", async () => {
    await page.keyboard.type("a", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "'", "'");
    await page.waitForTimeout(50);

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);

    const arr = await getBufferArray(page);
    expect(arr[0]).toBe("a");
    expect(arr[1]).toBe("'");
    expect(arr[2]).toBe("\x7f");
  });

  test("rapid typing with interleaved compositions", async () => {
    await page.keyboard.type("ab", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "'", "'");
    await page.waitForTimeout(50);

    await page.keyboard.type("cd", { delay: 30 });
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "˜", "~");
    await page.waitForTimeout(50);

    await page.keyboard.type("ef", { delay: 30 });
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("ab'cd~ef");
  });

  test("consecutive compositions without normal typing between", async () => {
    await simulateDeadKeyComposition(page, "'", "é");
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "˜", "ã");
    await page.waitForTimeout(50);

    await simulateDeadKeyComposition(page, "`", "è");
    await page.waitForTimeout(100);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("éãè");
  });

  test("no character duplication from dead key apostrophe", async () => {
    await simulateDeadKeyComposition(page, "'", "'");
    await page.waitForTimeout(100);

    const arr = await getBufferArray(page);
    const apostrophes = arr.filter((c) => c === "'");
    expect(apostrophes.length).toBe(1);
  });

  test("don't — apostrophe not duplicated with extra insertText after compositionend", async () => {
    // This simulates the hypothesized WKWebView behavior where an extra
    // insertText input event fires after compositionend, potentially
    // causing both CompositionHelper AND _inputEvent to emit the apostrophe.
    await page.keyboard.type("don", { delay: 30 });
    await page.waitForTimeout(50);

    await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea")!;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "'", bubbles: true }));
      ta.dispatchEvent(
        new InputEvent("input", {
          data: "'",
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          code: "Quote",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "'", bubbles: true }));
      // EXTRA: insertText after compositionend — the suspected cause of duplication
      ta.dispatchEvent(
        new InputEvent("input", {
          data: "'",
          inputType: "insertText",
          isComposing: false,
          bubbles: true,
        }),
      );
      // Stale keypress that WKWebView fires after compositionend
      ta.dispatchEvent(
        new KeyboardEvent("keypress", {
          key: "'",
          charCode: 39,
          bubbles: true,
        }),
      );
      // Trailing 't' keystroke
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "t",
          code: "KeyT",
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new InputEvent("input", {
          data: "t",
          inputType: "insertText",
          bubbles: true,
        }),
      );
    });
    await page.waitForTimeout(150);

    const buffer = await getBuffer(page);
    expect(buffer).toBe("don't");
  });

  test("standalone dead key apostrophe — exactly one apostrophe with stale keypress", async () => {
    // Includes the stale keypress that the original test was missing
    await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea")!;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "'", bubbles: true }));
      ta.dispatchEvent(
        new InputEvent("input", {
          data: "'",
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          code: "Quote",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "'", bubbles: true }));
      // Stale keypress
      ta.dispatchEvent(
        new KeyboardEvent("keypress", {
          key: "'",
          charCode: 39,
          bubbles: true,
        }),
      );
    });
    await page.waitForTimeout(150);

    const arr = await getBufferArray(page);
    const apostrophes = arr.filter((c) => c === "'");
    expect(apostrophes.length).toBe(1);
  });
});
