// @vitest-environment jsdom
/**
 * The Shortcuts panel and the declared app shortcuts.
 *
 *   - The panel renders every generated row through t(), so it is localized:
 *     in pt-BR it shows "Nova sessão", not the menu's English "New Session".
 *   - Every generated row/group key's English text equals the label defined
 *     in the menu / app-shortcuts.json, and every pack translates it.
 *   - matchAppShortcut (the only key matching App.tsx's handler does) fires
 *     exactly on the declared accelerators, per platform.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { registerLanguagePack, setLanguage, translate } from "../i18n/registry";
import { loadAllLanguagePacks } from "../i18n/packs";
import { ptBRPack } from "../i18n/packs/pt-BR";
import { ShortcutsPanel } from "../components/ShortcutsPanel";
import { GENERATED_SHORTCUT_GROUPS } from "../generated/shortcuts";
import { APP_SHORTCUTS, matchAppShortcut, matchesAccelerator, visibleShortcutGroups } from "../utils/shortcuts";
import { fmt } from "../utils/platform";

const ALL = GENERATED_SHORTCUT_GROUPS.flatMap((g) => g.shortcuts);

function renderPanel() {
  return render(
    <I18nProvider>
      <ShortcutsPanel onClose={() => {}} />
    </I18nProvider>,
  );
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".shortcuts-row")).map((row) => ({
    action: row.querySelector(".shortcuts-action")?.textContent ?? "",
    keys: row.querySelector(".shortcuts-kbd")?.textContent ?? "",
  }));
}

describe("ShortcutsPanel", () => {
  afterEach(async () => {
    cleanup();
    await setLanguage("en");
  });

  it("shows every shortcut that applies on this platform, in English by default", () => {
    const { container } = renderPanel();
    const expected = visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS).flatMap((g) =>
      g.shortcuts.map((s) => ({ action: s.label, keys: fmt(s.keys) })),
    );
    expect(rows(container)).toEqual(expected);
    // The app-handled bindings are listed too, not only menu accelerators.
    expect(screen.getByText("Focus Composer")).toBeInTheDocument();
    expect(screen.getByText("Workbench")).toBeInTheDocument();
    expect(screen.getByText("Switch to Session 1–9")).toBeInTheDocument();
  });

  it("renders group and action labels in the active language", async () => {
    const pack = registerLanguagePack(ptBRPack);
    try {
      const { container } = renderPanel();
      await act(async () => {
        await setLanguage("pt-BR");
      });
      const panel = container.querySelector(".shortcuts-panel") as HTMLElement;
      expect(within(panel).getByText("Nova sessão")).toBeInTheDocument();
      expect(within(panel).getByText("Arquivo")).toBeInTheDocument();
      expect(within(panel).getByText("Focar compositor")).toBeInTheDocument();
      expect(within(panel).queryByText("New Session")).toBeNull();
      // No raw i18n key leaks into the UI.
      for (const r of rows(container)) expect(r.action).not.toMatch(/^shortcuts\./);
    } finally {
      pack.dispose();
    }
  });
});

describe("generated shortcut table", () => {
  // Generated from src-tauri/src/menu/mod.rs (see scripts/generate-shortcuts.mjs),
  // so these guard the real menu definition, not a hand-maintained list.
  const find = (keys: string, mac = true) =>
    visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS, mac)
      .flatMap((g) => g.shortcuts)
      .find((s) => s.keys === keys);

  it("{mod}{shift}F is Search Panel, not Flow Mode", () => {
    expect(find("{mod}{shift}F")?.label).toBe("Search Panel");
  });

  it("{mod}{shift}Z is Flow Mode", () => {
    expect(find("{mod}{shift}Z")?.label).toBe("Flow Mode");
  });

  it("lists the left-panel tabs ({mod}P, {mod}G, {mod}F)", () => {
    expect(find("{mod}P")).toBeDefined();
    expect(find("{mod}G")).toBeDefined();
    expect(find("{mod}F")).toBeDefined();
  });

  it("binds no key twice on either platform", () => {
    for (const mac of [true, false]) {
      const keys = visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS, mac).flatMap((g) => g.shortcuts.map((s) => s.keys));
      expect(new Set(keys).size, mac ? "macOS" : "Windows / Linux").toBe(keys.length);
    }
  });
});

describe("visibleShortcutGroups", () => {
  const groups = [
    {
      group: "View",
      groupKey: "shortcuts.group.view",
      shortcuts: [
        { id: "a", label: "A", labelKey: "k.a", keys: "{mod}N", pcKeys: "{ctrl}{shift}N" },
        { id: "b", label: "B", labelKey: "k.b", keys: "{mod}B" },
        { id: "c", label: "C", labelKey: "k.c", keys: "{ctrl}C", platform: "macos" as const },
        { id: "d", label: "D", labelKey: "k.d", keys: "F11", platform: "not-macos" as const },
      ],
    },
  ];

  it("shows the macOS chord and the macOS-only rows on macOS", () => {
    const rows = visibleShortcutGroups(groups, true)[0].shortcuts.map((s) => [s.id, s.keys]);
    expect(rows).toEqual([
      ["a", "{mod}N"],
      ["b", "{mod}B"],
      ["c", "{ctrl}C"],
    ]);
  });

  it("shows the Windows/Linux chord where it differs, and the Windows/Linux-only rows", () => {
    const rows = visibleShortcutGroups(groups, false)[0].shortcuts.map((s) => [s.id, s.keys]);
    expect(rows).toEqual([
      ["a", "{ctrl}{shift}N"],
      ["b", "{mod}B"],
      ["d", "F11"],
    ]);
  });
});

describe("generated shortcut i18n keys", () => {
  it("English text of every row and group key equals the defined label", () => {
    for (const g of GENERATED_SHORTCUT_GROUPS) {
      expect(translate(g.groupKey), g.groupKey).toBe(g.group);
      for (const s of g.shortcuts) expect(translate(s.labelKey), s.labelKey).toBe(s.label);
    }
  });

  it("every language pack translates every row and group key", async () => {
    const keys = [...GENERATED_SHORTCUT_GROUPS.map((g) => g.groupKey), ...ALL.map((s) => s.labelKey)];
    for (const pack of await loadAllLanguagePacks()) {
      const missing = keys.filter((k) => !pack.messages[k]);
      expect(missing, pack.locale).toEqual([]);
    }
  });
});

describe("matchAppShortcut", () => {
  const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
    key: k,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });

  it("matches the declared bindings with ⌘ on macOS", () => {
    expect(matchAppShortcut(key("P", { meta: true, shift: true }), true)).toBe("app.command-palette-alt");
    expect(matchAppShortcut(key("p", { meta: true, shift: true }), true)).toBe("app.command-palette-alt");
    expect(matchAppShortcut(key("b", { meta: true, alt: true }), true)).toBe("app.toggle-workbench");
    expect(matchAppShortcut(key("J", { meta: true, shift: true }), true)).toBe("app.focus-composer");
    expect(matchAppShortcut(key("ArrowRight", { meta: true, alt: true }), true)).toBe("app.focus-next-pane");
    expect(matchAppShortcut(key("ArrowDown", { meta: true, alt: true }), true)).toBe("app.focus-next-pane");
    expect(matchAppShortcut(key("ArrowLeft", { meta: true, alt: true }), true)).toBe("app.focus-previous-pane");
    expect(matchAppShortcut(key("ArrowUp", { meta: true, alt: true }), true)).toBe("app.focus-previous-pane");
    expect(matchAppShortcut(key("1", { meta: true }), true)).toBe("app.switch-session");
    expect(matchAppShortcut(key("9", { meta: true }), true)).toBe("app.switch-session");
  });

  it("uses Ctrl as the action modifier off macOS", () => {
    expect(matchAppShortcut(key("P", { ctrl: true, shift: true }), false)).toBe("app.command-palette-alt");
    expect(matchAppShortcut(key("5", { ctrl: true }), false)).toBe("app.switch-session");
    expect(matchAppShortcut(key("P", { meta: true, shift: true }), false)).toBeNull();
    expect(matchAppShortcut(key("P", { ctrl: true, shift: true }), true)).toBeNull();
  });

  it("ignores keys and modifier sets nothing declares", () => {
    expect(matchAppShortcut(key("0", { meta: true }), true)).toBeNull();
    expect(matchAppShortcut(key("1"), true)).toBeNull();
    expect(matchAppShortcut(key("1", { meta: true, shift: true }), true)).toBeNull();
    expect(matchAppShortcut(key("P", { meta: true }), true)).toBeNull();
    expect(matchAppShortcut(key("ArrowRight", { meta: true }), true)).toBeNull();
    expect(matchAppShortcut(key("B", { meta: true, alt: true, shift: true }), true)).toBeNull();
  });

  it("removing a declaration removes the binding", () => {
    const withoutPalette = APP_SHORTCUTS.filter((s) => s.id !== "app.command-palette-alt");
    expect(matchAppShortcut(key("P", { meta: true, shift: true }), true, withoutPalette)).toBeNull();
  });

  it("every declared app shortcut is in the generated panel data with its first accelerator", () => {
    for (const s of APP_SHORTCUTS) {
      const row = ALL.find((r) => r.id === s.id);
      expect(row, s.id).toBeDefined();
      expect(row!.label).toBe(s.label);
    }
  });

  it("matchesAccelerator requires an explicit Ctrl token even on macOS", () => {
    expect(matchesAccelerator(key("c", { ctrl: true }), "Ctrl+C", true)).toBe(true);
    expect(matchesAccelerator(key("c", { meta: true }), "Ctrl+C", true)).toBe(false);
  });
});

describe("matchesAccelerator off macOS", () => {
  it("treats Ctrl and CmdOrCtrl as the same key", () => {
    const e = { key: "c", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
    expect(matchesAccelerator(e, "Ctrl+C", false)).toBe(true);
    expect(matchesAccelerator(e, "CmdOrCtrl+C", false)).toBe(true);
    expect(matchesAccelerator({ ...e, ctrlKey: false }, "Ctrl+C", false)).toBe(false);
  });
});
