// @vitest-environment jsdom
// Terminal keys, copy/paste, right-click accelerators and font size on
// Windows/Linux (XP-01, XP-02, XP-03, XP-07, XP-08, XP-09, CHAOS-01).
import { describe, expect, it } from "vitest";
import {
  ctrlCCopiesSelection,
  isAppShortcutInTerminal,
  parseFontSize,
  terminalClipboardAction,
  type TerminalKeyEvent,
} from "../terminal/terminalKeys";
import { acceleratorFor, buildPaneHeaderMenuItems, buildTerminalMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import { handleAppChordKeydown, isTextEditingTarget } from "../hooks/appChordListener";
import { chordFor } from "../utils/keymap";
import { parseWorktreeToml } from "../agent/contract/worktreeToml";
import { isUnexpectedExit, turnTimerStart } from "../agent/AgentSessionView";

function key(k: string, mods: Partial<Record<"ctrl" | "shift" | "alt" | "meta", boolean>> = {}, code?: string): TerminalKeyEvent {
  return {
    type: "keydown",
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };
}

describe("app shortcuts are not terminal input on Windows/Linux (XP-01, XP-09)", () => {
  it("Ctrl+1..9 switch sessions instead of typing ESC, FS, GS...", () => {
    for (const d of "123456789") {
      expect(isAppShortcutInTerminal(key(d, { ctrl: true }), "linux")).toBe(true);
      expect(isAppShortcutInTerminal(key(d, { ctrl: true }), "win")).toBe(true);
    }
  });

  it("Alt+Arrow and Ctrl+Alt+Arrow move between panes", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(isAppShortcutInTerminal(key(k, { alt: true }), "linux")).toBe(true);
      expect(isAppShortcutInTerminal(key(k, { ctrl: true, alt: true }), "win")).toBe(true);
    }
  });

  it("leaves plain terminal keys and macOS alone", () => {
    expect(isAppShortcutInTerminal(key("c", { ctrl: true }), "linux")).toBe(false);
    expect(isAppShortcutInTerminal(key("ArrowLeft"), "linux")).toBe(false);
    expect(isAppShortcutInTerminal(key("3", { ctrl: true }), "mac")).toBe(false);
  });
});

describe("terminal copy and paste (XP-02, XP-03)", () => {
  it("Ctrl+Shift+C copies and Ctrl+Shift+V / Shift+Insert paste on Windows and Linux", () => {
    for (const p of ["win", "linux"] as const) {
      expect(terminalClipboardAction(key("C", { ctrl: true, shift: true }), p, true, false)).toBe("copy");
      expect(terminalClipboardAction(key("V", { ctrl: true, shift: true }), p, false, false)).toBe("paste");
      expect(terminalClipboardAction(key("Insert", { shift: true }), p, false, false)).toBe("paste");
    }
    // Physical key on a non-Latin layout.
    expect(terminalClipboardAction(key("С", { ctrl: true, shift: true }, "KeyC"), "linux", true, false)).toBe("copy");
    expect(terminalClipboardAction(key("C", { meta: true, shift: true }), "mac", true, false)).toBeNull();
    // Only on keydown.
    expect(terminalClipboardAction({ ...key("C", { ctrl: true, shift: true }), type: "keyup" }, "win", true, false)).toBeNull();
  });

  it("Ctrl+C copies a selection only where that is on (Windows by default), else it interrupts", () => {
    const ctrlC = key("c", { ctrl: true });
    expect(terminalClipboardAction(ctrlC, "win", true, ctrlCCopiesSelection({}, "win"))).toBe("copy");
    expect(terminalClipboardAction(ctrlC, "win", false, ctrlCCopiesSelection({}, "win"))).toBeNull();
    expect(terminalClipboardAction(ctrlC, "linux", true, ctrlCCopiesSelection({}, "linux"))).toBeNull();
    expect(ctrlCCopiesSelection({ ctrl_c_copies_selection: "false" }, "win")).toBe(false);
    expect(ctrlCCopiesSelection({ ctrl_c_copies_selection: "true" }, "linux")).toBe(true);
    expect(ctrlCCopiesSelection({ ctrl_c_copies_selection: "true" }, "mac")).toBe(false);
  });

  it("Copy Context moved off Ctrl+Shift+C on Windows/Linux", () => {
    expect(chordFor("session.copy-context", "linux")).toBe("{ctrl}{shift}X");
    expect(chordFor("session.copy-context", "mac")).toBe("{mod}{shift}C");
  });
});

describe("terminal font size (CHAOS-01)", () => {
  it("keeps the size between 8 and 40, 14 when unreadable", () => {
    expect(parseFontSize("0")).toBe(14);
    expect(parseFontSize("-3")).toBe(14);
    expect(parseFontSize("abc")).toBe(14);
    expect(parseFontSize(undefined)).toBe(14);
    expect(parseFontSize("2")).toBe(8);
    expect(parseFontSize("400")).toBe(40);
    expect(parseFontSize("16")).toBe(16);
  });
});

describe("right-click accelerators follow the keymap (XP-07)", () => {
  const accel = (items: ReturnType<typeof buildTerminalMenuItems>, id: string) => items.find((i) => i.id === id)?.accelerator ?? null;

  it("shows the Windows/Linux chords there", () => {
    const term = buildTerminalMenuItems(true, "linux");
    expect(accel(term, "terminal.split-right")).toBe("Ctrl+Shift+D");
    expect(accel(term, "terminal.split-down")).toBe("Ctrl+Shift+S");
    expect(accel(term, "terminal.copy")).toBe("Ctrl+Shift+C");
    expect(accel(term, "terminal.paste")).toBe("Ctrl+Shift+V");
    expect(accel(term, "terminal.clear")).toBeNull();
    const pane = buildPaneHeaderMenuItems("p", true, undefined, "win");
    expect(accel(pane, "pane.close")).toBe("Ctrl+Shift+W");
    expect(accel(buildEmptyAreaMenuItems("sidebar", "win"), "empty.new-session")).toBe("Ctrl+Shift+N");
  });

  it("keeps the macOS chords on macOS", () => {
    const term = buildTerminalMenuItems(true, "mac");
    expect(accel(term, "terminal.split-right")).toBe("CmdOrCtrl+D");
    expect(accel(term, "terminal.split-down")).toBe("CmdOrCtrl+Shift+D");
    expect(accel(term, "terminal.copy")).toBe("CmdOrCtrl+C");
    expect(acceleratorFor("view.flow-mode", "mac")).toBe("CmdOrCtrl+Alt+Z");
  });
});

describe("editing keys stay with text fields (XP-08)", () => {
  it("knows a text field from a terminal", () => {
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    xterm.appendChild(helper);
    const box = document.createElement("input");
    box.type = "checkbox";
    expect(isTextEditingTarget(input)).toBe(true);
    expect(isTextEditingTarget(area)).toBe(true);
    expect(isTextEditingTarget(helper)).toBe(false);
    expect(isTextEditingTarget(box)).toBe(false);
  });

  it("Ctrl+Shift+Z in a text field is Redo, not an app chord; Flow Mode is Ctrl+Shift+Y", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const ran: string[] = [];
    const press = (k: string, target: Element) => {
      const e = new KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(e, "target", { value: target });
      return handleAppChordKeydown(e, "linux", (a) => ran.push(a));
    };
    expect(press("Z", input)).toBe(false);
    expect(press("Y", input)).toBe(true);
    expect(ran).toEqual(["view.flow-mode"]);
    input.remove();
  });
});

describe("worktree.toml never recurses (CHAOS-17)", () => {
  it("refuses an array inside an array with its line", () => {
    expect(parseWorktreeToml('setup = [["npm ci"]]')).toEqual({ ok: false, error: "arrays may not be nested", line: 1 });
  });

  it("answers at once for thousands of nested brackets", () => {
    const deep = `copy = ${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    const started = Date.now();
    const result = parseWorktreeToml(deep);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("Agent view after a crash (CHAOS-20)", () => {
  it("counts the turn from the newest message, never from a dead turn", () => {
    const messages = [
      { role: "user", timestamp: 1_000 },
      { role: "assistant", timestamp: 1_100 },
      { role: "user", timestamp: 90_000 },
    ];
    expect(turnTimerStart(1_100, messages)).toBe(90_000);
    expect(turnTimerStart(95_000, messages)).toBe(95_000);
    expect(turnTimerStart(null, messages)).toBeNull();
  });

  it("knows a crash from a normal end", () => {
    expect(isUnexpectedExit({ code: 0, signal: null })).toBe(false);
    expect(isUnexpectedExit({ code: null, signal: "SIGKILL" })).toBe(true);
    expect(isUnexpectedExit({ code: 1, signal: null })).toBe(true);
    expect(isUnexpectedExit(null)).toBe(false);
  });
});
