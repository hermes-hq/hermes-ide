/**
 * macOS CMD+Left/Right → Home/End key mapping
 *
 * On macOS, CMD+Left and CMD+Right should move the cursor to the
 * beginning and end of the line respectively, matching native terminal
 * behavior (Terminal.app, iTerm2, Ghostty). xterm.js does not do this
 * by default, so we intercept these keys in the custom key handler and
 * send Home/End escape sequences to the PTY.
 *
 * This mapping is macOS-only — on Windows and Linux, Home/End keys
 * exist on the keyboard and xterm.js handles them natively.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const SRC: string = readFileSync(
  new URL("../terminal/pool.ts", import.meta.url),
  "utf-8",
);

describe("macOS CMD+Arrow → Home/End mapping", () => {
  it("intercepts CMD+ArrowLeft and sends Home escape sequence", () => {
    expect(SRC).toContain('"ArrowLeft"');
    expect(SRC).toContain('"\\x1bOH"'); // ESC O H — Home
  });

  it("intercepts CMD+ArrowRight and sends End escape sequence", () => {
    expect(SRC).toContain('"ArrowRight"');
    expect(SRC).toContain('"\\x1bOF"'); // ESC O F — End
  });

  it("only activates on macOS (isMac guard)", () => {
    // The mapping block must be gated behind isMac
    const block = SRC.match(
      /isMac\s*&&[\s\S]*?ArrowLeft[\s\S]*?ArrowRight[\s\S]*?return false;\s*\}/,
    );
    expect(block).not.toBeNull();
  });

  it("requires metaKey (CMD) without alt or ctrl modifiers", () => {
    // Must check metaKey and exclude alt/ctrl to avoid conflicting
    // with other shortcuts (e.g. CMD+Alt+Arrow for pane navigation)
    const block = SRC.match(
      /isMac[\s\S]*?_event\.metaKey[\s\S]*?!_event\.altKey[\s\S]*?!_event\.ctrlKey/,
    );
    expect(block).not.toBeNull();
  });

  it("only fires on keydown events", () => {
    const block = SRC.match(
      /isMac[\s\S]*?_event\.type\s*===\s*"keydown"[\s\S]*?ArrowLeft/,
    );
    expect(block).not.toBeNull();
  });

  it("calls preventDefault to suppress browser behavior", () => {
    const block = SRC.match(
      /ArrowLeft[\s\S]*?preventDefault[\s\S]*?ArrowRight[\s\S]*?preventDefault/,
    );
    expect(block).not.toBeNull();
  });

  it("returns false to prevent xterm from processing the event", () => {
    // After sending the escape sequence, must return false so xterm
    // does not also process the keydown event
    const arrowLeftBlock = SRC.match(
      /"ArrowLeft"[\s\S]*?return false/,
    );
    const arrowRightBlock = SRC.match(
      /"ArrowRight"[\s\S]*?return false/,
    );
    expect(arrowLeftBlock).not.toBeNull();
    expect(arrowRightBlock).not.toBeNull();
  });

  it("routes through handleTerminalInput (not direct PTY write)", () => {
    // Must go through the input handler so intelligence features
    // (input buffer, suggestions) stay in sync
    const homeCall = SRC.match(/handleTerminalInput\(sessionId,\s*"\\x1bOH"\)/);
    const endCall = SRC.match(/handleTerminalInput\(sessionId,\s*"\\x1bOF"\)/);
    expect(homeCall).not.toBeNull();
    expect(endCall).not.toBeNull();
  });
});

describe("Windows/Linux do NOT remap CMD+Arrow", () => {
  it("mapping is exclusively behind isMac check", () => {
    // The ArrowLeft/ArrowRight Home/End mapping must only appear
    // inside a block guarded by isMac — no unconditional mapping
    const allArrowBlocks = SRC.match(
      /attachCustomKeyEventHandler[\s\S]*?\}\)/,
    );
    expect(allArrowBlocks).not.toBeNull();
    const handlerBody = allArrowBlocks![0];

    // Find the Home/End mapping — it must be inside an isMac block
    const homeEndMapping = handlerBody.match(
      /\\x1bOH|\\x1bOF/g,
    );
    expect(homeEndMapping).not.toBeNull();
    expect(homeEndMapping!.length).toBe(2); // exactly one Home + one End

    // Both must appear after an isMac guard, not at the top level
    const beforeHome = handlerBody.split("\\x1bOH")[0];
    expect(beforeHome).toContain("isMac");
  });

  it("does not interfere with Ctrl+Arrow (word navigation) on any platform", () => {
    // The mapping requires metaKey — ctrlKey is explicitly excluded.
    // This ensures Ctrl+Left/Right (word-by-word navigation) works
    // on all platforms without interference.
    const block = SRC.match(
      /isMac[\s\S]*?!_event\.ctrlKey[\s\S]*?ArrowLeft/,
    );
    expect(block).not.toBeNull();
  });
});
