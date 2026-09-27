// Behavioural tests for the shortcuts generator: parsing menu/mod.rs-shaped
// source, grouping, key rendering, and the repository's own generated files
// against its own menu definition.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  extractShortcuts,
  groupShortcuts,
  macKeys,
  MENU_SOURCE,
  MD_OUT,
  pcKeys,
  renderMarkdown,
  renderTsModule,
  toCanonicalKeys,
  TS_OUT,
} from "./generate-shortcuts.mjs";

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
    const before = extractShortcuts(FIXTURE).find((i) => i.id === "file.new-session").accelerator;
    const after = extractShortcuts(changed).find((i) => i.id === "file.new-session").accelerator;
    expect(before).not.toBe(after);
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

describe("this repository's generated shortcuts", () => {
  it("src/generated/shortcuts.ts and docs/shortcuts.md match what the menu currently generates", () => {
    const source = readFileSync(MENU_SOURCE, "utf8");
    const groups = groupShortcuts(extractShortcuts(source));
    expect(groups.length).toBeGreaterThan(0);
    expect(readFileSync(TS_OUT, "utf8")).toBe(renderTsModule(groups));
    expect(readFileSync(MD_OUT, "utf8")).toBe(renderMarkdown(groups));
  });
});
