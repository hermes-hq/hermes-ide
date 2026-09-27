// @vitest-environment jsdom
/**
 * The Keyboard Shortcuts panel lists what the app actually binds: every
 * accelerator of the native menu, plus the Agent-view shortcuts, and no
 * stale rows (the old "Toggle Timeline" on Cmd+T is gone).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("mocked"))) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));

import { ShortcutsPanel } from "../components/ShortcutsPanel";
import { I18nProvider } from "../i18n/I18nProvider";
import { fmt, isMac } from "../utils/platform";

function rows(): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of document.querySelectorAll(".shortcuts-row")) {
    const action = row.querySelector(".shortcuts-action")?.textContent ?? "";
    const keys = row.querySelector(".shortcuts-kbd")?.textContent ?? "";
    out.set(keys, action);
  }
  return out;
}

describe("ShortcutsPanel rows", () => {
  afterEach(() => cleanup());

  it("shows New Tab (shell) on Mod+T and no Timeline row", () => {
    render(<I18nProvider><ShortcutsPanel onClose={() => {}} /></I18nProvider>);
    expect(rows().get(fmt("{mod}T"))).toBe("New Tab (shell)");
    expect(screen.queryByText(/Timeline/i)).not.toBeInTheDocument();
  });

  it("lists every native-menu accelerator", () => {
    render(<I18nProvider><ShortcutsPanel onClose={() => {}} /></I18nProvider>);
    const shown = rows();
    // CmdOrCtrl accelerators registered in the native menu, on every OS.
    const menu = ["N", "T", "W", "F", ",", "B", "K", "J", "P", "G", "E", "$", "/", "D", "{shift}D", "{shift}Z", "{shift}F", "{shift}C"];
    for (const k of menu) {
      const want = fmt(`{mod}${k}`);
      const found = [...shown.keys()].some((keys) => keys.split(" / ").includes(want));
      expect(found, `row for ${want}`).toBe(true);
    }
    // Platform-specific menu items.
    if (isMac) {
      expect(shown.get(fmt("{ctrl}C"))).toBe("Send Interrupt");
      expect(shown.get(fmt("{ctrl}{mod}F"))).toBe("Toggle Fullscreen");
    } else {
      expect(shown.get("F11")).toBe("Toggle Fullscreen");
    }
  });

  it("lists the Agent-view shortcuts under their own group", () => {
    render(<I18nProvider><ShortcutsPanel onClose={() => {}} /></I18nProvider>);
    expect(screen.getByText("Agent view")).toBeInTheDocument();
    expect(rows().get(fmt("{mod}{shift}J"))).toBe("Focus Composer");
    expect(rows().get(fmt("{mod}{alt}B"))).toBe("Toggle Workbench");
  });
});
