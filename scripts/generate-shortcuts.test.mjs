// Behavioural tests for the shortcuts generator: parsing menu/mod.rs-shaped
// source, grouping, key rendering, and the repository's own generated files
// against its own menu definition.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_SOURCE,
  combineShortcuts,
  extractShortcuts,
  groupKeyFor,
  groupShortcuts,
  labelKeyFor,
  loadShortcutGroups,
  MAC_SYMBOLS,
  macKeys,
  MENU_SOURCE,
  MD_OUT,
  parseAppShortcuts,
  parseKeymap,
  PC_SYMBOLS,
  pcKeys,
  renderMarkdown,
  renderTsModule,
  sameText,
  toCanonicalKeys,
  TS_OUT,
} from "./generate-shortcuts.mjs";
import { MAC_SYMBOLS as APP_MAC_SYMBOLS, PC_SYMBOLS as APP_PC_SYMBOLS } from "../src/utils/platform.ts";

const FIXTURE = `
use tauri::menu::MenuItemBuilder;

pub fn build(app: &AppHandle) {
    // ── File menu ──
    let new_session = MenuItemBuilder::with_id("file.new-session", "New Session")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let find = MenuItemBuilder::with_id("edit.find", "Find...").build(app)?;

    #[cfg(target_os = "macos")]
    let send_interrupt = MenuItemBuilder::with_id("edit.send-interrupt", "Send Interrupt")
        .accelerator("Ctrl+C")
        .build(app)?;

    #[cfg(not(target_os = "macos"))]
    {
        let fullscreen = MenuItemBuilder::with_id("view.fullscreen", "Toggle Fullscreen")
            .accelerator("F11")
            .build(app)?;
    }

    // ── View menu ──
    let toggle_sidebar = CheckMenuItemBuilder::with_id("view.toggle-sidebar", "Sidebar")
        .accelerator("CmdOrCtrl+Shift+D")
        .checked(true)
        .build(app)?;

    // ─── Not a menu group, a section banner ────────────────────────────
    let unrelated = MenuItemBuilder::with_id("other.thing", "Should not appear").build(app)?;
}
`;

describe("extractShortcuts", () => {
  it("only keeps items with both an id/label and an explicit accelerator", () => {
    const items = extractShortcuts(FIXTURE);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("file.new-session");
    expect(ids).toContain("edit.send-interrupt");
    expect(ids).toContain("view.fullscreen");
    expect(ids).toContain("view.toggle-sidebar");
    // No accelerator -> not a shortcut.
    expect(ids).not.toContain("edit.find");
    // A 3-dash banner is not a menu group, but its item still has no
    // accelerator either way, so it is excluded regardless.
    expect(ids).not.toContain("other.thing");
  });

  it("reads a CRLF checkout of the menu exactly like an LF one", () => {
    const crlf = FIXTURE.replace(/\n/g, "\r\n");
    expect(extractShortcuts(crlf)).toEqual(extractShortcuts(FIXTURE));
    expect(extractShortcuts(crlf).find((i) => i.id === "edit.send-interrupt").platform).toBe("macos");
  });

  it("assigns each item to the nearest preceding 2-dash menu header", () => {
    const items = extractShortcuts(FIXTURE);
    expect(items.find((i) => i.id === "file.new-session").group).toBe("File");
    expect(items.find((i) => i.id === "edit.send-interrupt").group).toBe("File");
    expect(items.find((i) => i.id === "view.toggle-sidebar").group).toBe("View");
  });

  it("tags items whose accelerator only exists on one platform family", () => {
    const items = extractShortcuts(FIXTURE);
    expect(items.find((i) => i.id === "edit.send-interrupt").platform).toBe("macos");
    expect(items.find((i) => i.id === "view.fullscreen").platform).toBe("not-macos");
    expect(items.find((i) => i.id === "file.new-session").platform).toBeUndefined();
  });

  it("removing a shortcut from the menu changes what's extracted (and so the generated table)", () => {
    const before = extractShortcuts(FIXTURE).map((i) => i.id);
    const withoutOne = FIXTURE.replace(
      /let new_session[\s\S]*?\.build\(app\)\?;\n/,
      "",
    );
    const after = extractShortcuts(withoutOne).map((i) => i.id);
    expect(before).toContain("file.new-session");
    expect(after).not.toContain("file.new-session");
    expect(renderMarkdown(groupShortcuts(extractShortcuts(FIXTURE)))).not.toEqual(
      renderMarkdown(groupShortcuts(extractShortcuts(withoutOne))),
    );
    expect(renderTsModule(groupShortcuts(extractShortcuts(FIXTURE)))).not.toEqual(
      renderTsModule(groupShortcuts(extractShortcuts(withoutOne))),
    );
  });

  it("changing an accelerator in the menu changes the rendered keys", () => {
    const changed = FIXTURE.replace('"CmdOrCtrl+N"', '"CmdOrCtrl+Shift+N"');
    expect(extractShortcuts(FIXTURE).find((i) => i.id === "file.new-session").keys).toBe("{mod}N");
    expect(extractShortcuts(changed).find((i) => i.id === "file.new-session").keys).toBe("{mod}{shift}N");
  });
});

// The same menu once its chords move into src/utils/keymap.json: the menu
// reads each through app_accel("<id>")?, and Windows/Linux chords differ.
const KEYMAP_FIXTURE = FIXTURE.replace('.accelerator("CmdOrCtrl+N")', '.accelerator(app_accel("file.new-session")?)').replace(
  '.accelerator("CmdOrCtrl+Shift+D")',
  '.accelerator(app_accel("view.toggle-sidebar")?)',
);
const KEYMAP = parseKeymap({
  chords: [
    { action: "file.new-session", mac: "{mod}N", pc: "{ctrl}{shift}N", pcOutsideTerminal: "{ctrl}N" },
    { action: "view.toggle-sidebar", mac: "{mod}{shift}D", pc: "{ctrl}{shift}D" },
  ],
});

describe("chords read from keymap.json", () => {
  it("keeps every row, with the per-platform chords", () => {
    const literal = extractShortcuts(FIXTURE).map((i) => i.id);
    const items = extractShortcuts(KEYMAP_FIXTURE, KEYMAP);
    expect(items.map((i) => i.id)).toEqual(literal);
    const newSession = items.find((i) => i.id === "file.new-session");
    expect(newSession).toMatchObject({ keys: "{mod}N", pcKeys: "{ctrl}{shift}N", pcOutsideTerminal: "{ctrl}N", group: "File" });
    expect(items.find((i) => i.id === "view.toggle-sidebar").pcKeys).toBe("{ctrl}{shift}D");
  });

  it("renders the macOS and Windows/Linux chords in their own columns", () => {
    const md = renderMarkdown(groupShortcuts(extractShortcuts(KEYMAP_FIXTURE, KEYMAP)));
    expect(md).toContain("| New Session | ⌘N | Ctrl+Shift+N | Windows / Linux: also Ctrl+N when no terminal has focus |");
    const ts = renderTsModule(groupShortcuts(extractShortcuts(KEYMAP_FIXTURE, KEYMAP)));
    expect(ts).toContain('keys: "{mod}N", pcKeys: "{ctrl}{shift}N"');
  });

  it("fails instead of dropping a row when a chord is missing or unreadable", () => {
    expect(() => extractShortcuts(KEYMAP_FIXTURE)).toThrow(/reads its chord from keymap.json as "file.new-session"/);
    const partial = parseKeymap({ chords: [{ action: "file.new-session", mac: "{mod}N", pc: "{ctrl}{shift}N" }] });
    expect(() => extractShortcuts(KEYMAP_FIXTURE, partial)).toThrow(/"view.toggle-sidebar"/);
    const odd = FIXTURE.replace('.accelerator("F11")', ".accelerator(fullscreen_key())");
    expect(() => extractShortcuts(odd)).toThrow(/view.fullscreen" has an accelerator the shortcuts generator cannot read/);
  });

  it("fails when keymap.json has a chord no menu item uses", () => {
    const extra = parseKeymap({
      chords: [
        { action: "file.new-session", mac: "{mod}N", pc: "{ctrl}{shift}N" },
        { action: "view.toggle-sidebar", mac: "{mod}{shift}D", pc: "{ctrl}{shift}D" },
        { action: "view.gone", mac: "{mod}Y", pc: "{ctrl}{shift}Y" },
      ],
    });
    expect(() => extractShortcuts(KEYMAP_FIXTURE, extra)).toThrow(/"view.gone", but no menu item uses it/);
  });

  it("rejects a malformed keymap", () => {
    expect(() => parseKeymap({})).toThrow(/chords/);
    expect(() => parseKeymap({ chords: [{ action: "a", mac: "", pc: "{ctrl}A" }] })).toThrow(/"mac"/);
    expect(() => parseKeymap({ chords: [{ action: "a", mac: "{mod}A", pc: "{ctrl}A" }, { action: "a", mac: "{mod}B", pc: "{ctrl}B" }] })).toThrow(/duplicate/);
  });

  it("an app shortcut that clashes with a Windows/Linux chord is rejected", () => {
    const menu = extractShortcuts(KEYMAP_FIXTURE, KEYMAP);
    const clash = { shortcuts: [{ id: "app.z", group: "View", label: "Z", accelerators: ["Ctrl+Shift+N"] }] };
    expect(() => combineShortcuts(menu, parseAppShortcuts(clash))).toThrow(/Ctrl\+Shift\+N \(Windows \/ Linux\) is bound twice/);
    // A legacy outside-terminal chord still occupies its key.
    const legacy = { shortcuts: [{ id: "app.w", group: "View", label: "W", accelerators: ["Ctrl+N"] }] };
    expect(() => combineShortcuts(menu, parseAppShortcuts(legacy))).toThrow(/Ctrl\+N \(Windows \/ Linux\)/);
  });
});

describe("check mode line endings", () => {
  it("treats a CRLF checkout of the generated files as up to date", () => {
    expect(sameText("a\r\nb\r\n", "a\nb\n")).toBe(true);
    expect(sameText("a\nb\n", "a\nc\n")).toBe(false);
    expect(sameText(null, "a")).toBe(false);
  });
});

describe("groupShortcuts", () => {
  it("groups in first-seen order and drops empty groups", () => {
    const groups = groupShortcuts(extractShortcuts(FIXTURE));
    expect(groups.map((g) => g.group)).toEqual(["File", "View"]);
    expect(groups.every((g) => g.shortcuts.length > 0)).toBe(true);
  });
});

describe("key rendering", () => {
  it("converts an accelerator to the canonical token string", () => {
    expect(toCanonicalKeys("CmdOrCtrl+N")).toBe("{mod}N");
    expect(toCanonicalKeys("CmdOrCtrl+Shift+D")).toBe("{mod}{shift}D");
    expect(toCanonicalKeys("Ctrl+C")).toBe("{ctrl}C");
    expect(toCanonicalKeys("F11")).toBe("F11");
  });

  it("renders the same canonical string differently per platform", () => {
    expect(macKeys("CmdOrCtrl+Shift+D")).toBe("⌘⇧D");
    expect(pcKeys("CmdOrCtrl+Shift+D")).toBe("Ctrl+Shift+D");
    expect(macKeys("Ctrl+C")).toBe("⌃C");
    expect(pcKeys("F11")).toBe("F11");
  });
});

describe("renderTsModule / renderMarkdown", () => {
  it("produce parseable, non-empty output for a small menu", () => {
    const groups = groupShortcuts(extractShortcuts(FIXTURE));
    const ts = renderTsModule(groups);
    expect(ts).toContain("export const GENERATED_SHORTCUT_GROUPS");
    expect(ts).toContain('"file.new-session"');
    // The array literal itself (TS types aside) must be valid JS.
    const arrayLiteral = /GENERATED_SHORTCUT_GROUPS: GeneratedShortcutGroup\[\] = (\[[\s\S]*\]);/.exec(ts)[1];
    expect(() => new Function(`return ${arrayLiteral}`)).not.toThrow();

    const md = renderMarkdown(groups);
    expect(md).toContain("## File");
    expect(md).toContain("New Session");
    expect(md).toContain("macOS only");
    expect(md).toContain("Windows / Linux only");
  });
});

describe("app-handled shortcuts (src/shortcuts/app-shortcuts.json)", () => {
  const APP = {
    shortcuts: [
      { id: "app.focus-composer", group: "Session", label: "Focus Composer", accelerators: ["CmdOrCtrl+Shift+J"], note: "Agent sessions only" },
      { id: "app.focus-next-pane", group: "Panes", label: "Focus Next Pane", accelerators: ["CmdOrCtrl+Alt+Right", "CmdOrCtrl+Alt+Down"] },
    ],
  };

  it("are merged into the menu group of the same name, and new groups come after the menu's", () => {
    const menu = extractShortcuts(FIXTURE.replace("// ── View menu ──", "// ── Session menu ──"));
    const groups = groupShortcuts(combineShortcuts(menu, parseAppShortcuts(APP)));
    expect(groups.map((g) => g.group)).toEqual(["File", "Session", "Panes"]);
    expect(groups[1].shortcuts.map((s) => s.id)).toEqual(["view.toggle-sidebar", "app.focus-composer"]);
  });

  it("render the first accelerator, and list the rest and the note in the docs", () => {
    const groups = groupShortcuts(combineShortcuts([], parseAppShortcuts(APP)));
    const ts = renderTsModule(groups);
    expect(ts).toContain('keys: "{mod}{alt}→"');
    const md = renderMarkdown(groups);
    expect(md).toContain("| Focus Next Pane | ⌘⌥→ | Ctrl+Alt+→ | also ⌘⌥↓ / Ctrl+Alt+↓ |");
    expect(md).toContain("| Focus Composer | ⌘⇧J | Ctrl+Shift+J | Agent sessions only |");
  });

  it("removing one changes the generated table", () => {
    const without = { shortcuts: APP.shortcuts.slice(1) };
    const md = (doc) => renderMarkdown(groupShortcuts(combineShortcuts([], parseAppShortcuts(doc))));
    expect(md(APP)).toContain("Focus Composer");
    expect(md(without)).not.toContain("Focus Composer");
  });

  it("reject a key combo the menu already binds, and a duplicate id", () => {
    const menu = extractShortcuts(FIXTURE);
    const clash = { shortcuts: [{ id: "app.x", group: "View", label: "X", accelerators: ["CmdOrCtrl+N"] }] };
    expect(() => combineShortcuts(menu, parseAppShortcuts(clash))).toThrow(/⌘N \(macOS\) is bound twice: "file.new-session" and "app.x"/);
    // Ctrl+N and CmdOrCtrl+N are different keys on macOS, the same key elsewhere.
    const pcClash = { shortcuts: [{ id: "app.y", group: "View", label: "Y", accelerators: ["Ctrl+N"] }] };
    expect(() => combineShortcuts(menu, parseAppShortcuts(pcClash))).toThrow(/Ctrl\+N \(Windows \/ Linux\) is bound twice/);
    const dup = { shortcuts: [APP.shortcuts[0], APP.shortcuts[0]] };
    expect(() => parseAppShortcuts(dup)).toThrow(/duplicate id/);
    expect(() => parseAppShortcuts({ shortcuts: [{ id: "a", group: "G", label: "L", accelerators: [] }] })).toThrow(/accelerators/);
  });

  it("take their own Windows/Linux keys from pcAccelerators, which are checked for clashes on that platform", () => {
    const doc = { shortcuts: [{ id: "app.z", group: "Session", label: "Z", accelerators: ["CmdOrCtrl+I"], pcAccelerators: ["Ctrl+Shift+I"] }] };
    const md = renderMarkdown(groupShortcuts(combineShortcuts([], parseAppShortcuts(doc))));
    expect(md).toContain("| Z | ⌘I | Ctrl+Shift+I |");
    const menu = extractShortcuts(KEYMAP_FIXTURE, KEYMAP);
    const clash = { shortcuts: [{ id: "app.w", group: "View", label: "W", accelerators: ["CmdOrCtrl+Alt+W"], pcAccelerators: ["Ctrl+Shift+N"] }] };
    expect(() => combineShortcuts(menu, parseAppShortcuts(clash))).toThrow(/Ctrl\+Shift\+N \(Windows \/ Linux\) is bound twice/);
    expect(() => parseAppShortcuts({ shortcuts: [{ ...doc.shortcuts[0], pcAccelerators: [] }] })).toThrow(/pcAccelerators/);
  });
});

describe("i18n keys", () => {
  it("derive a stable key from the id and the group name", () => {
    expect(labelKeyFor("file.new-session")).toBe("shortcuts.item.file.newSession");
    expect(labelKeyFor("app.command-palette-alt")).toBe("shortcuts.item.app.commandPaletteAlt");
    expect(groupKeyFor("File")).toBe("shortcuts.group.file");
  });

  it("are written into the generated module", () => {
    const ts = renderTsModule(groupShortcuts(extractShortcuts(FIXTURE)));
    expect(ts).toContain('labelKey: "shortcuts.item.file.newSession"');
    expect(ts).toContain('groupKey: "shortcuts.group.file"');
  });
});

describe("symbol tables", () => {
  it("agree with fmt()'s tables in src/utils/platform.ts", () => {
    expect(MAC_SYMBOLS).toEqual(APP_MAC_SYMBOLS);
    expect(PC_SYMBOLS).toEqual(APP_PC_SYMBOLS);
  });
});

describe("this repository's generated shortcuts", () => {
  it("src/generated/shortcuts.ts and docs/shortcuts.md match what the menu and app-shortcuts.json currently generate", () => {
    const groups = loadShortcutGroups(readFileSync(MENU_SOURCE, "utf8"), readFileSync(APP_SOURCE, "utf8"));
    expect(groups.length).toBeGreaterThan(0);
    expect(readFileSync(TS_OUT, "utf8")).toBe(renderTsModule(groups));
    expect(readFileSync(MD_OUT, "utf8")).toBe(renderMarkdown(groups));
  });

  it("the generated module has no doubled blank line after its header", () => {
    expect(readFileSync(TS_OUT, "utf8")).not.toMatch(/\n\n\n/);
  });
});
