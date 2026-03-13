/**
 * Suggestion Overlay Keyboard Navigation Tests
 *
 * Tests for keyboard navigation of the suggestion overlay:
 * - Arrow keys (↑/↓) navigate with wrapping
 * - Application cursor mode (\x1bOA/\x1bOB) support
 * - Overlay-only guard (no intelligenceActive dependency for key interception)
 * - Enter/Tab accept highlighted suggestion
 * - Enter passes through when nothing highlighted
 * - Esc dismisses without accepting
 * - Typing resets selection to null
 * - Keys pass through when overlay is not visible
 * - Acceptance writes suffix only (not full command)
 * - Phase change dismisses overlay
 * - Ctrl-C dismisses overlay then passes through
 * - Mouse interaction (onSelect, onAccept, scrollIntoView)
 */
import { describe, it, expect, vi } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ─── Source Code for Structural Tests ─────────────────────────────────

const TERMINAL_POOL_SRC: string = readFileSync(
  new URL("../terminal/TerminalPool.ts", import.meta.url),
  "utf-8",
);

const POOL_SRC: string = readFileSync(
  new URL("../terminal/pool.ts", import.meta.url),
  "utf-8",
);

const OVERLAY_SRC: string = readFileSync(
  new URL("../terminal/intelligence/SuggestionOverlay.tsx", import.meta.url),
  "utf-8",
);

// ─── Helpers ─────────────────────────────────────────────────────────

/** Simulates moveSuggestionSelection logic extracted from source */
function moveSuggestionSelection(
  selectedIndex: number | null,
  delta: number,
  count: number,
): number {
  if (selectedIndex === null) {
    return delta > 0 ? 0 : count - 1;
  }
  return ((selectedIndex + delta) % count + count) % count;
}

// =============================================================================
// DOWN ARROW TESTS
// =============================================================================

describe("Overlay: Down arrow selects first item", () => {
  it("down arrow from null selection goes to index 0", () => {
    const result = moveSuggestionSelection(null, 1, 5);
    expect(result).toBe(0);
  });

  it("source handles null selectedIndex for down arrow", () => {
    expect(TERMINAL_POOL_SRC).toContain("s.selectedIndex === null");
    expect(TERMINAL_POOL_SRC).toContain("delta > 0 ? 0 : count - 1");
  });
});

describe("Overlay: Down arrow wraps to top", () => {
  it("down arrow from last item wraps to 0", () => {
    expect(moveSuggestionSelection(4, 1, 5)).toBe(0);
  });

  it("wrapping uses modular arithmetic, not clamping", () => {
    const moveFn = TERMINAL_POOL_SRC.match(
      /function moveSuggestionSelection[\s\S]*?\n\}/,
    );
    expect(moveFn).not.toBeNull();
    expect(moveFn![0]).not.toContain("Math.max");
    expect(moveFn![0]).not.toContain("Math.min");
  });
});

// =============================================================================
// UP ARROW TESTS
// =============================================================================

describe("Overlay: Up arrow selects last item", () => {
  it("up arrow from null selection goes to last item", () => {
    expect(moveSuggestionSelection(null, -1, 5)).toBe(4);
  });

  it("up arrow from null with 3 items goes to index 2", () => {
    expect(moveSuggestionSelection(null, -1, 3)).toBe(2);
  });
});

describe("Overlay: Up arrow wraps to bottom", () => {
  it("up arrow from index 0 wraps to last item", () => {
    expect(moveSuggestionSelection(0, -1, 5)).toBe(4);
  });

  it("up arrow from index 0 with 3 items wraps to index 2", () => {
    expect(moveSuggestionSelection(0, -1, 3)).toBe(2);
  });
});

// =============================================================================
// APPLICATION CURSOR MODE — CRITICAL REGRESSION GUARD
// =============================================================================

describe("Overlay: Application cursor mode sequences handled", () => {
  it("source intercepts \\x1bOA (application mode up arrow)", () => {
    expect(TERMINAL_POOL_SRC).toContain('"\\x1bOA"');
    // Must be in the same condition as normal mode
    const upArrowLine = TERMINAL_POOL_SRC.match(
      /data === "\\x1b\[A" \|\| data === "\\x1bOA"/,
    );
    expect(upArrowLine).not.toBeNull();
  });

  it("source intercepts \\x1bOB (application mode down arrow)", () => {
    expect(TERMINAL_POOL_SRC).toContain('"\\x1bOB"');
    const downArrowLine = TERMINAL_POOL_SRC.match(
      /data === "\\x1b\[B" \|\| data === "\\x1bOB"/,
    );
    expect(downArrowLine).not.toBeNull();
  });

  it("source intercepts \\x1bOC (application mode right arrow) for ghost text", () => {
    expect(TERMINAL_POOL_SRC).toContain('"\\x1bOC"');
    const rightArrowLine = TERMINAL_POOL_SRC.match(
      /data === "\\x1b\[C" \|\| data === "\\x1bOC"/,
    );
    expect(rightArrowLine).not.toBeNull();
  });
});

// =============================================================================
// OVERLAY-ONLY GUARD — PREVENTS PHASE-FLICKER DROPS
// =============================================================================

describe("Overlay: Key interception guards on overlay visibility, not intelligenceActive", () => {
  it("overlay key interception uses overlayVisible guard without intelligenceActive", () => {
    // The guard should be: if (overlayVisible && entry.suggestionState)
    // NOT: if (intelligenceActive && overlayVisible && entry.suggestionState)
    // This prevents phase-flicker (brief "busy" from shell echo) from dropping arrow keys
    expect(TERMINAL_POOL_SRC).toContain(
      "if (overlayVisible && entry.suggestionState)",
    );
  });

  it("intelligenceActive is NOT part of the overlay interception guard", () => {
    // The line after the overlay interception comment should NOT include intelligenceActive
    const lines = TERMINAL_POOL_SRC.split("\n");
    const guardIdx = lines.findIndex((l) => l.includes("Overlay key interception"));
    expect(guardIdx).toBeGreaterThan(-1);
    // Find the next if-statement after the comment block
    let ifLine = "";
    for (let i = guardIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("if (")) {
        ifLine = lines[i];
        break;
      }
    }
    expect(ifLine).toContain("overlayVisible");
    expect(ifLine).not.toContain("intelligenceActive");
  });

  it("intelligenceActive is still used for suggestion computation gating", () => {
    // intelligenceActive should still gate suggestion computation, not key interception
    expect(TERMINAL_POOL_SRC).toContain(
      '(phase === "idle" || phase === "shell_ready")',
    );
  });
});

// =============================================================================
// ENTER TESTS
// =============================================================================

describe("Overlay: Enter accepts selected suggestion", () => {
  it("source calls executeSuggestion when selectedIndex is not null", () => {
    const handleFn = TERMINAL_POOL_SRC.match(
      /\/\/ Enter — accept highlighted[\s\S]*?\/\/ Fall through to normal Enter/,
    );
    expect(handleFn).not.toBeNull();
    expect(handleFn![0]).toContain("selectedIndex !== null");
    expect(handleFn![0]).toContain("executeSuggestion(sessionId)");
  });

  it("executeSuggestion guards against null selectedIndex", () => {
    const execFn = TERMINAL_POOL_SRC.match(
      /function executeSuggestion[\s\S]*?\n\}/,
    );
    expect(execFn).not.toBeNull();
    expect(execFn![0]).toContain("selectedIndex === null");
  });
});

describe("Overlay: Enter passes through when nothing selected", () => {
  it("source dismisses overlay and falls through when selectedIndex is null", () => {
    const handleFn = TERMINAL_POOL_SRC.match(
      /\/\/ Enter — accept highlighted[\s\S]*?\/\/ Fall through to normal Enter/,
    );
    expect(handleFn).not.toBeNull();
    expect(handleFn![0]).toContain("dismissSuggestions(sessionId)");
    // Must NOT return after dismiss — should fall through to PTY
    const afterDismiss = handleFn![0].split("dismissSuggestions(sessionId)")[1];
    expect(afterDismiss).not.toMatch(/return;\s*\/\/ CONSUME/);
  });
});

// =============================================================================
// ESC TEST
// =============================================================================

describe("Overlay: Esc dismisses without accepting", () => {
  it("source handles Escape by dismissing only (no suggestion acceptance)", () => {
    const handleFn = TERMINAL_POOL_SRC.match(
      /\/\/ Escape — dismiss overlay[\s\S]*?return; \/\/ CONSUME/,
    );
    expect(handleFn).not.toBeNull();
    const escBlock = handleFn![0];
    expect(escBlock).toContain("dismissSuggestions(sessionId)");
    expect(escBlock).not.toContain("acceptSuggestion");
    expect(escBlock).not.toContain("executeSuggestion");
  });
});

// =============================================================================
// TYPING RESETS SELECTION
// =============================================================================

describe("Overlay: Typing resets selection to null", () => {
  it("computeSuggestions sets selectedIndex to null (not 0)", () => {
    const computeFn = TERMINAL_POOL_SRC.match(
      /function computeSuggestions[\s\S]*?\n\}/,
    );
    expect(computeFn).not.toBeNull();
    expect(computeFn![0]).toContain("selectedIndex: null");
    expect(computeFn![0]).not.toContain("selectedIndex: 0");
  });
});

// =============================================================================
// TAB TESTS
// =============================================================================

describe("Overlay: Tab accepts selected suggestion", () => {
  it("source checks selectedIndex !== null before accepting on Tab", () => {
    const handleFn = TERMINAL_POOL_SRC.match(
      /\/\/ Tab — accept selected[\s\S]*?\/\/ Nothing highlighted/,
    );
    expect(handleFn).not.toBeNull();
    expect(handleFn![0]).toContain("selectedIndex !== null");
    expect(handleFn![0]).toContain("acceptSuggestion(sessionId)");
  });

  it("acceptSuggestion guards against null selectedIndex", () => {
    const acceptFn = TERMINAL_POOL_SRC.match(
      /function acceptSuggestion\(sessionId: string\)[\s\S]*?\n\}/,
    );
    expect(acceptFn).not.toBeNull();
    expect(acceptFn![0]).toContain("selectedIndex === null");
  });
});

// =============================================================================
// PASSTHROUGH TESTS (overlay NOT visible)
// =============================================================================

describe("Overlay: Keys pass through when not visible", () => {
  it("arrows are NOT intercepted when overlay is hidden", () => {
    // After the overlay block, there should be no standalone arrow interception
    const outsideOverlay = TERMINAL_POOL_SRC.split(
      "// Any other key: pass to PTY, update buffer, re-query",
    )[1] ?? "";
    expect(outsideOverlay).not.toMatch(
      /if\s*\(data === "\\x1b\[A"\)/,
    );
    expect(outsideOverlay).not.toMatch(
      /if\s*\(data === "\\x1b\[B"\)/,
    );
  });

  it("Enter outside overlay block passes through to PTY", () => {
    expect(TERMINAL_POOL_SRC).toContain("writeToSession(sessionId, utf8ToBase64(data))");
  });

  it("Esc outside overlay block does not consume the event", () => {
    const updateFn = TERMINAL_POOL_SRC.match(
      /function updateInputBuffer[\s\S]*?\n\}/,
    );
    expect(updateFn).not.toBeNull();
    expect(updateFn![0]).toContain("0x1b");
    expect(updateFn![0]).toContain("dismissSuggestionsForEntry");
  });
});

// =============================================================================
// ACCEPTANCE LOGIC
// =============================================================================

describe("Overlay: Acceptance writes suffix correctly", () => {
  it("acceptSuggestion erases current input then writes selected text", () => {
    const acceptFn = TERMINAL_POOL_SRC.match(
      /function acceptSuggestion\(sessionId: string\)[\s\S]*?\n\}/,
    );
    expect(acceptFn).not.toBeNull();
    const body = acceptFn![0];
    expect(body).toContain('\\x7f".repeat(currentInput.length)');
    expect(body).toContain("eraseSequence + selected.text");
    expect(body).toContain("entry.inputBuffer = selected.text");
  });

  it("executeSuggestion erases and writes full suggestion + Enter", () => {
    const execFn = TERMINAL_POOL_SRC.match(
      /function executeSuggestion[\s\S]*?\n\}/,
    );
    expect(execFn).not.toBeNull();
    const body = execFn![0];
    expect(body).toContain('selected.text + "\\r"');
    expect(body).toContain("historyProvider.addCommand(selected.text)");
  });
});

// =============================================================================
// PHASE CHANGE DISMISSAL
// =============================================================================

describe("Overlay: Dismisses on phase change", () => {
  it("setSessionPhase dismisses suggestions when phase leaves idle/shell_ready", () => {
    const phaseFn = POOL_SRC.match(
      /export function setSessionPhase[\s\S]*?\n\}/,
    );
    expect(phaseFn).not.toBeNull();
    expect(phaseFn![0]).toContain("dismissSuggestions");
  });
});

// =============================================================================
// CTRL-C HANDLING
// =============================================================================

describe("Overlay: Ctrl-C dismisses overlay when visible", () => {
  it("source handles Ctrl-C in overlay block by dismissing", () => {
    const handleFn = TERMINAL_POOL_SRC.match(
      /\/\/ Ctrl-C — dismiss overlay[\s\S]*?\/\/ Fall through/,
    );
    expect(handleFn).not.toBeNull();
    expect(handleFn![0]).toContain("dismissSuggestions(sessionId)");
    // Must fall through (not return) so Ctrl-C reaches PTY
    expect(handleFn![0]).not.toContain("return;");
  });
});

// =============================================================================
// SELECTEDINDEX TYPE & MOUSE INTERACTION
// =============================================================================

describe("Overlay: SuggestionState and component features", () => {
  it("SuggestionState interface declares selectedIndex as number | null", () => {
    expect(OVERLAY_SRC).toContain("selectedIndex: number | null");
  });

  it("overlay component checks for null when applying selected class", () => {
    expect(OVERLAY_SRC).toContain("selectedIndex !== null");
  });

  it("overlay component uses scrollIntoView for highlighted items", () => {
    expect(OVERLAY_SRC).toContain("scrollIntoView");
  });

  it("overlay component supports onSelect callback for mouse hover", () => {
    expect(OVERLAY_SRC).toContain("onSelect?.(i)");
    expect(OVERLAY_SRC).toContain("onMouseEnter");
  });

  it("overlay component supports onAccept callback for mouse click", () => {
    expect(OVERLAY_SRC).toContain("onAccept?.(i)");
    expect(OVERLAY_SRC).toContain("onClick");
  });

  it("overlay prevents mousedown from stealing terminal focus", () => {
    expect(OVERLAY_SRC).toContain("onMouseDown");
    expect(OVERLAY_SRC).toContain("e.preventDefault()");
  });

  it("overlay supports flip-above positioning", () => {
    expect(OVERLAY_SRC).toContain("flipAbove");
    expect(OVERLAY_SRC).toContain("suggestion-overlay-above");
  });
});

// =============================================================================
// PUBLIC API FOR MOUSE INTERACTION
// =============================================================================

describe("Overlay: Public functions for mouse interaction", () => {
  it("selectSuggestion is exported for hover highlighting", () => {
    expect(TERMINAL_POOL_SRC).toContain("export function selectSuggestion(");
  });

  it("acceptSuggestionAtIndex is exported for click acceptance", () => {
    expect(TERMINAL_POOL_SRC).toContain("export function acceptSuggestionAtIndex(");
  });

  it("selectSuggestion updates ghost text to preview the hovered item", () => {
    const fn = TERMINAL_POOL_SRC.match(
      /export function selectSuggestion[\s\S]*?\n\}/,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("showGhostText");
  });
});

// =============================================================================
// ALTERNATE BUFFER & SCROLL GUARDS
// =============================================================================

describe("Overlay: Suppressed when phase is not shell-interactive", () => {
  it("computeSuggestions uses lastStablePhase (immune to echo-flicker)", () => {
    const computeFn = TERMINAL_POOL_SRC.match(
      /function computeSuggestions[\s\S]*?\n\}/,
    );
    expect(computeFn).not.toBeNull();
    // Must use lastStablePhase (not sessionPhase) to avoid echo-flicker
    expect(computeFn![0]).toContain("lastStablePhase");
    expect(computeFn![0]).toContain('lastStablePhase !== "idle"');
    expect(computeFn![0]).toContain('lastStablePhase !== "shell_ready"');
  });

  it("setSessionPhase tracks lastStablePhase (excludes 'busy')", () => {
    // pool.ts must update lastStablePhase for all phases except "busy"
    expect(POOL_SRC).toContain("lastStablePhase");
    expect(POOL_SRC).toContain('phase !== "busy"');
  });
});

describe("Overlay: Suppressed during alternate screen buffer", () => {
  it("computeSuggestions checks for alternate buffer and returns early", () => {
    const computeFn = TERMINAL_POOL_SRC.match(
      /function computeSuggestions[\s\S]*?\n\}/,
    );
    expect(computeFn).not.toBeNull();
    expect(computeFn![0]).toContain('buffer.active.type === "alternate"');
  });

  it("handleTerminalInput dismisses overlay when alternate buffer is active", () => {
    // When the terminal switches to alternate buffer (interactive CLI tool starts),
    // the overlay should be dismissed so keys reach the tool
    expect(TERMINAL_POOL_SRC).toContain(
      'entry.terminal.buffer.active.type === "alternate"',
    );
    // The dismissal should happen BEFORE the overlay interception guard
    const src = TERMINAL_POOL_SRC;
    const altCheck = src.indexOf('buffer.active.type === "alternate"');
    const overlayGuard = src.indexOf("Overlay key interception");
    expect(altCheck).toBeGreaterThan(0);
    expect(overlayGuard).toBeGreaterThan(altCheck);
  });
});

describe("Overlay: Suppressed when user scrolled up", () => {
  it("computeSuggestions checks userScrolledUp flag", () => {
    const computeFn = TERMINAL_POOL_SRC.match(
      /function computeSuggestions[\s\S]*?\n\}/,
    );
    expect(computeFn).not.toBeNull();
    expect(computeFn![0]).toContain("userScrolledUp");
  });
});

describe("Overlay: OS-level foreground process check (synchronous cached poll)", () => {
  it("computeSuggestions checks entry.shellIsForeground synchronously", () => {
    const computeFn = TERMINAL_POOL_SRC.match(
      /function computeSuggestions[\s\S]*?\n\}/,
    );
    expect(computeFn).not.toBeNull();
    expect(computeFn![0]).toContain("shellIsForeground");
  });

  it("computeSuggestions is synchronous (no async IPC in hot path)", () => {
    // Must NOT be async — uses cached poll value instead
    expect(TERMINAL_POOL_SRC).not.toContain(
      "async function computeSuggestions(",
    );
    expect(TERMINAL_POOL_SRC).toContain(
      "function computeSuggestions(",
    );
  });

  it("pool.ts sets up a polling interval for isShellForeground", () => {
    // The polling timer is started in createTerminal
    expect(POOL_SRC).toContain("shellFgPollTimer");
    expect(POOL_SRC).toContain("isShellForeground(sessionId)");
    expect(POOL_SRC).toContain("setInterval");
  });

  it("pool.ts cleans up shellFgPollTimer in destroy()", () => {
    const destroyFn = POOL_SRC.match(
      /export function destroy[\s\S]*?\n\}/,
    );
    expect(destroyFn).not.toBeNull();
    expect(destroyFn![0]).toContain("shellFgPollTimer");
    expect(destroyFn![0]).toContain("clearInterval");
  });

  it("PoolEntry interface includes shellIsForeground and shellFgPollTimer", () => {
    expect(POOL_SRC).toContain("shellIsForeground: boolean");
    expect(POOL_SRC).toContain("shellFgPollTimer:");
  });
});

// =============================================================================
// CURSOR POSITION COORDINATE SPACE
// =============================================================================

describe("Overlay: Cursor position accounts for DOM offset", () => {
  it("getCursorPixelPosition uses getBoundingClientRect for coordinate space translation", () => {
    expect(POOL_SRC).toContain("getBoundingClientRect");
    // Should query .xterm-screen for the rendering area position
    expect(POOL_SRC).toContain(".xterm-screen");
  });

  it("getCursorPixelPosition adds offset from xterm-screen to wrapper", () => {
    const cursorFn = POOL_SRC.match(
      /export function getCursorPixelPosition[\s\S]*?\n\}/,
    );
    expect(cursorFn).not.toBeNull();
    const body = cursorFn![0];
    // Should compute offset between screen element and wrapper
    expect(body).toContain("screenRect");
    expect(body).toContain("wrapperRect");
    // Should add the offset to x and y
    expect(body).toContain("screenRect.left - wrapperRect.left");
    expect(body).toContain("screenRect.top - wrapperRect.top");
  });
});

// =============================================================================
// WRAPPING ARITHMETIC
// =============================================================================

describe("Overlay: Navigation wrapping is correct for all boundary cases", () => {
  it("navigating down through all items and back to top", () => {
    const count = 4;
    let idx: number | null = null;
    idx = moveSuggestionSelection(idx, 1, count);
    expect(idx).toBe(0);
    idx = moveSuggestionSelection(idx, 1, count);
    idx = moveSuggestionSelection(idx, 1, count);
    idx = moveSuggestionSelection(idx, 1, count);
    expect(idx).toBe(3);
    idx = moveSuggestionSelection(idx, 1, count);
    expect(idx).toBe(0);
  });

  it("navigating up through all items and back to bottom", () => {
    const count = 4;
    let idx: number | null = null;
    idx = moveSuggestionSelection(idx, -1, count);
    expect(idx).toBe(3);
    idx = moveSuggestionSelection(idx, -1, count);
    idx = moveSuggestionSelection(idx, -1, count);
    idx = moveSuggestionSelection(idx, -1, count);
    expect(idx).toBe(0);
    idx = moveSuggestionSelection(idx, -1, count);
    expect(idx).toBe(3);
  });

  it("single-item list always stays at 0", () => {
    expect(moveSuggestionSelection(null, 1, 1)).toBe(0);
    expect(moveSuggestionSelection(0, 1, 1)).toBe(0);
    expect(moveSuggestionSelection(0, -1, 1)).toBe(0);
  });

  it("two-item list wraps correctly", () => {
    expect(moveSuggestionSelection(null, 1, 2)).toBe(0);
    expect(moveSuggestionSelection(0, 1, 2)).toBe(1);
    expect(moveSuggestionSelection(1, 1, 2)).toBe(0);
    expect(moveSuggestionSelection(null, -1, 2)).toBe(1);
    expect(moveSuggestionSelection(0, -1, 2)).toBe(1);
    expect(moveSuggestionSelection(1, -1, 2)).toBe(0);
  });
});
