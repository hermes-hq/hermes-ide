// @vitest-environment jsdom
/**
 * Terminal-faithful keys on Windows and Linux.
 *
 * A focused terminal owns Ctrl+letter (Ctrl+D end-of-input, Ctrl+W delete
 * word, Ctrl+E end of line, ...). App chords there are Ctrl+Shift+letter.
 * Outside a terminal the older Ctrl+letter chords still run their action.
 * macOS is unchanged (Cmd chords come from the native menu).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  APP_CHORDS,
  chordFor,
  isAppChordInTerminal,
  isTerminalFocused,
  matchAppChord,
  pcLetterChord,
  shortcutLabel,
} from "../utils/keymap";
import { handleAppChordKeydown, installAppChordListener } from "../hooks/appChordListener";
import { GENERATED_SHORTCUT_GROUPS } from "../generated/shortcuts";
import { visibleShortcutGroups } from "../utils/shortcuts";
import { fmt, formatChord, type Platform } from "../utils/platform";

/** The Shortcuts panel's rows as a platform sees them (generated from the menu, N23). */
function panelRows(platform: Platform) {
  return visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS, platform === "mac").flatMap((g) => g.shortcuts);
}
function panelChord(id: string, platform: Platform): string {
  const row = panelRows(platform).find((r) => r.id === id);
  if (!row) throw new Error(`no panel row for ${id}`);
  return formatChord(row.keys, platform);
}

function key(letter: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) {
  const upper = letter.toUpperCase();
  return {
    key: mods.shift ? upper : letter.toLowerCase(),
    code: `Key${upper}`,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };
}

const CTRL = { ctrl: true };
const CTRL_SHIFT = { ctrl: true, shift: true };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("keymap: Windows/Linux", () => {
  for (const platform of ["win", "linux"] as const) {
    it(`${platform}: Ctrl+letter inside a terminal is never an app chord`, () => {
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        expect(matchAppChord(key(letter, CTRL), platform, true)).toBeNull();
        expect(isAppChordInTerminal(key(letter, CTRL), platform)).toBe(false);
      }
    });

    it(`${platform}: Ctrl+Shift+D splits the pane, also from a terminal`, () => {
      expect(matchAppChord(key("d", CTRL_SHIFT), platform, true)).toBe("view.split-horizontal");
      expect(isAppChordInTerminal(key("d", CTRL_SHIFT), platform)).toBe(true);
    });

    it(`${platform}: Ctrl+D outside a terminal still splits the pane`, () => {
      expect(matchAppChord(key("d", CTRL), platform, false)).toBe("view.split-horizontal");
    });
  }

  it("every Ctrl+letter chord from before still works outside a terminal", () => {
    const legacy: Record<string, string> = {
      N: "file.new-session",
      T: "file.new-session-tab",
      W: "file.close-pane",
      F: "file.file-explorer",
      B: "view.toggle-sidebar",
      K: "view.command-palette",
      J: "view.prompt-composer",
      P: "view.process-panel",
      G: "view.git-panel",
      E: "view.context-panel",
      D: "view.split-horizontal",
    };
    for (const [letter, action] of Object.entries(legacy)) {
      expect(matchAppChord(key(letter, CTRL), "linux", false)).toBe(action);
    }
  });

  it("the palette's Ctrl+Shift+P and the composer's Ctrl+Shift+J skip the terminal", () => {
    expect(isAppChordInTerminal(key("p", CTRL_SHIFT), "win")).toBe(true);
    expect(isAppChordInTerminal(key("j", CTRL_SHIFT), "win")).toBe(true);
  });

  it("Ctrl+Shift+letter with no app action stays terminal input", () => {
    expect(isAppChordInTerminal(key("a", CTRL_SHIFT), "linux")).toBe(false);
    expect(matchAppChord(key("a", CTRL_SHIFT), "linux", true)).toBeNull();
  });

  it("uses the physical key only when the layout gives no Latin letter", () => {
    const russian = { ...key("d", CTRL_SHIFT), key: "В" };
    expect(matchAppChord(russian, "win", true)).toBe("view.split-horizontal");
  });

  it("follows the layout's letter on AZERTY, like the native menu does", () => {
    // AZERTY: the key printed W sits where QWERTY has Z (code KeyZ).
    const azertyW = { ...key("w", CTRL_SHIFT), code: "KeyZ" };
    expect(pcLetterChord(azertyW)).toBe("{ctrl}{shift}W");
    expect(matchAppChord(azertyW, "linux", true)).toBe("file.close-pane");
    // And a key printed D on the physical W key is Split Right, not Close Pane.
    const printedD = { ...key("d", CTRL_SHIFT), code: "KeyW" };
    expect(matchAppChord(printedD, "linux", true)).toBe("view.split-horizontal");
    // Dvorak: plain Ctrl+E typed on the physical D key stays terminal input.
    const dvorakCtrlE = { ...key("e", CTRL), code: "KeyD" };
    expect(matchAppChord(dvorakCtrlE, "win", true)).toBeNull();
    expect(isAppChordInTerminal(dvorakCtrlE, "win")).toBe(false);
  });

  it("ignores Alt and Meta combinations", () => {
    expect(pcLetterChord(key("d", { ctrl: true, alt: true }))).toBeNull();
    expect(pcLetterChord(key("d", { ctrl: true, meta: true }))).toBeNull();
    expect(pcLetterChord(key("d"))).toBeNull();
  });

  it("no two actions share a chord on either platform", () => {
    for (const field of ["mac", "pc"] as const) {
      const chords = APP_CHORDS.map((c) => c[field]);
      expect(new Set(chords).size).toBe(chords.length);
    }
  });

  it("labels show Ctrl+Shift chords on Windows/Linux and Cmd on macOS", () => {
    expect(shortcutLabel("view.split-horizontal", "win")).toBe("Ctrl+Shift+D");
    expect(shortcutLabel("view.split-horizontal", "linux")).toBe("Ctrl+Shift+D");
    expect(shortcutLabel("view.split-horizontal", "mac")).toBe("⌘D");
    expect(shortcutLabel("file.close-pane", "win")).toBe("Ctrl+Shift+W");
    expect(shortcutLabel("hermes.settings", "linux")).toBe("Ctrl+,");
    expect(shortcutLabel("view.nope", "linux")).toBe("");
    expect(chordFor("view.nope", "mac")).toBeNull();
  });
});

describe("keymap: macOS is unchanged", () => {
  it("never claims a key in the webview (the native menu owns Cmd chords)", () => {
    expect(matchAppChord(key("d", CTRL), "mac", false)).toBeNull();
    expect(matchAppChord(key("d", CTRL_SHIFT), "mac", true)).toBeNull();
    expect(isAppChordInTerminal(key("d", CTRL_SHIFT), "mac")).toBe(false);
  });

  it("keeps the Cmd chords", () => {
    expect(shortcutLabel("view.split-horizontal", "mac")).toBe("⌘D");
    expect(shortcutLabel("view.split-vertical", "mac")).toBe("⌘⇧D");
    expect(shortcutLabel("view.command-palette", "mac")).toBe("⌘K");
  });
});

describe("app chord listener in the page", () => {
  function terminalTextarea(): HTMLTextAreaElement {
    const host = document.createElement("div");
    host.className = "xterm";
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    host.appendChild(ta);
    document.body.appendChild(host);
    return ta;
  }

  function press(target: Element, letter: string, mods: { ctrl?: boolean; shift?: boolean }) {
    const ev = new KeyboardEvent("keydown", {
      ...key(letter, mods),
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    return ev;
  }

  it("Ctrl+D typed in a terminal reaches it untouched; Ctrl+Shift+D runs the split", () => {
    const run = vi.fn();
    const cleanupListener = installAppChordListener(window, "linux", run);
    const ta = terminalTextarea();
    ta.focus();
    expect(isTerminalFocused(document.activeElement)).toBe(true);

    const plain = press(ta, "d", CTRL);
    expect(plain.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const shifted = press(ta, "d", CTRL_SHIFT);
    expect(shifted.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith("view.split-horizontal");
    cleanupListener();
  });

  it("Ctrl+D in a text field (not a terminal) runs the split", () => {
    const run = vi.fn();
    const cleanupListener = installAppChordListener(window, "win", run);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ev = press(input, "d", CTRL);
    expect(ev.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith("view.split-horizontal");
    cleanupListener();
  });

  it("does nothing on macOS", () => {
    const run = vi.fn();
    const cleanupListener = installAppChordListener(window, "mac", run);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input, "d", CTRL);
    press(input, "d", CTRL_SHIFT);
    expect(run).not.toHaveBeenCalled();
    cleanupListener();
  });

  it("leaves keys another handler already consumed, and key repeats", () => {
    const run = vi.fn();
    const consumed = new KeyboardEvent("keydown", { ...key("t", CTRL), cancelable: true });
    consumed.preventDefault();
    expect(handleAppChordKeydown(consumed, "linux", run)).toBe(false);
    const repeat = new KeyboardEvent("keydown", { ...key("d", CTRL_SHIFT), repeat: true, cancelable: true });
    expect(handleAppChordKeydown(repeat, "linux", run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", () => {
    const run = vi.fn();
    installAppChordListener(window, "linux", run)();
    press(document.body, "d", CTRL_SHIFT);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("one key press runs the action once", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@tauri-apps/api/event");
  });

  async function loadBridge() {
    let deliver: ((e: { payload: { action: string } }) => void) | null = null;
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(async (_name: string, cb: (e: { payload: { action: string } }) => void) => {
        deliver = cb;
        return () => {};
      }),
    }));
    const bridge = await import("../hooks/nativeMenuBridge");
    await bridge.ensureListener();
    return { bridge, native: (action: string) => deliver!({ payload: { action } }) };
  }

  it("drops the native menu echo of a chord the page already handled", async () => {
    const { bridge, native } = await loadBridge();
    const handler = vi.fn();
    bridge.registerMenuBarHandler(handler);
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    native("view.split-horizontal");
    expect(handler).toHaveBeenCalledTimes(1);
    // A later, separate menu click still works.
    native("view.split-horizontal");
    expect(handler).toHaveBeenCalledTimes(2);
    bridge.cleanupListener();
  });

  it("drops the page's keydown when the native menu already ran the same chord", async () => {
    const { bridge, native } = await loadBridge();
    const handler = vi.fn();
    bridge.registerMenuBarHandler(handler);
    native("view.split-horizontal");
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    expect(handler).toHaveBeenCalledTimes(1);
    // The next key press is a new one and runs again.
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    expect(handler).toHaveBeenCalledTimes(2);
    bridge.cleanupListener();
  });

  it("two separate key presses of the same chord both run", async () => {
    const { bridge } = await loadBridge();
    const handler = vi.fn();
    bridge.registerMenuBarHandler(handler);
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    expect(handler).toHaveBeenCalledTimes(2);
    bridge.cleanupListener();
  });

  it("an echo more than half a second later is a new press", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { bridge, native } = await loadBridge();
    const handler = vi.fn();
    bridge.registerMenuBarHandler(handler);
    native("view.git-panel");
    now.mockReturnValue(1_600);
    bridge.triggerMenuBarActionFromKeyboard("view.git-panel");
    expect(handler).toHaveBeenCalledTimes(2);
    now.mockRestore();
    bridge.cleanupListener();
  });

  it("does not drop a different native action", async () => {
    const { bridge, native } = await loadBridge();
    const handler = vi.fn();
    bridge.registerMenuBarHandler(handler);
    bridge.triggerMenuBarActionFromKeyboard("view.split-horizontal");
    native("view.git-panel");
    expect(handler.mock.calls.map((c) => c[0])).toEqual(["view.split-horizontal", "view.git-panel"]);
    bridge.cleanupListener();
  });
});

describe("Shortcuts panel", () => {
  it("shows platform-correct chords", () => {
    expect(panelChord("view.split-horizontal", "linux")).toBe("Ctrl+Shift+D");
    expect(panelChord("view.split-horizontal", "win")).toBe("Ctrl+Shift+D");
    expect(panelChord("view.split-horizontal", "mac")).toBe("⌘D");
    expect(panelChord("view.command-palette", "win")).toBe("Ctrl+Shift+K");
    expect(panelChord("view.command-palette", "mac")).toBe("⌘K");
    expect(panelChord("app.command-palette-alt", "win")).toBe("Ctrl+Shift+P");
    expect(panelChord("app.command-palette-alt", "mac")).toBe("⌘⇧P");
  });

  it("no Windows/Linux row asks for a bare Ctrl+letter", () => {
    for (const platform of ["win", "linux"] as const) {
      for (const s of panelRows(platform)) {
        expect(formatChord(s.keys, platform)).not.toMatch(/^Ctrl\+[A-Z]$/);
      }
    }
  });

  it("Processes avoids Ctrl+Shift+U, which IBus on Linux takes for Unicode entry", () => {
    expect(shortcutLabel("view.process-panel", "linux")).toBe("Ctrl+Shift+L");
    for (const c of APP_CHORDS) expect(c.pc).not.toBe("{ctrl}{shift}U");
  });

  it("labels the New Tab row as New Tab", async () => {
    const { ShortcutsPanel } = await import("../components/ShortcutsPanel");
    const { I18nProvider } = await import("../i18n/I18nProvider");
    const { getByText } = render(
      <I18nProvider>
        <ShortcutsPanel onClose={() => {}} />
      </I18nProvider>,
    );
    const row = getByText("New Tab").closest(".shortcuts-row")!;
    expect(row.querySelector("kbd")!.textContent).toBe(shortcutLabel("file.new-session-tab"));
  });

  it("renders the rows for the current platform", async () => {
    const { ShortcutsPanel } = await import("../components/ShortcutsPanel");
    const { I18nProvider } = await import("../i18n/I18nProvider");
    const { container } = render(
      <I18nProvider>
        <ShortcutsPanel onClose={() => {}} />
      </I18nProvider>,
    );
    const kbds = [...container.querySelectorAll("kbd.shortcuts-kbd")].map((k) => k.textContent);
    const expected = visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS).flatMap((g) => g.shortcuts).map((s) => fmt(s.keys));
    expect(kbds).toEqual(expected);
  });
});
