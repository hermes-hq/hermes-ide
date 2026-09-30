// @vitest-environment jsdom
/**
 * Settings on the control set: a vertical tab list driven by the arrow
 * keys, every on/off setting a switch that saves at once, every choice a
 * select that looks like the others, and Export/Import as real buttons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    innerSize: async () => ({ width: 1200, height: 800 }),
    scaleFactor: async () => 1,
    onResized: async () => () => {},
    setSize: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/dpi", () => ({ LogicalSize: class {} }));
vi.mock("../state/SessionContext", () => ({ useSession: () => ({ dispatch: vi.fn(), state: {} }) }));
vi.mock("../api/ssh", () => ({
  listSshSavedHosts: async () => [],
  upsertSshSavedHost: vi.fn(),
  deleteSshSavedHost: vi.fn(),
}));
vi.mock("../utils/analytics", () => ({ setAnalyticsEnabled: vi.fn() }));
vi.mock("../hooks/useTextContextMenu", () => ({ useTextContextMenu: () => ({ onContextMenu: vi.fn() }) }));
vi.mock("../components/PluginManager", () => ({ PluginManager: () => null }));
vi.mock("../components/AgentDoctor", () => ({ AgentDoctor: () => null }));
vi.mock("../components/AgentsSettings", () => ({ AgentsSettings: () => null }));
vi.mock("../fleet/FleetSettingsTab", () => ({ FleetSettingsTab: () => null }));

import { I18nProvider } from "../i18n/I18nProvider";
import { Settings } from "../components/Settings";

function mockBackend(settings: Record<string, string>) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return settings;
    if (cmd === "get_available_shells") return [];
    return undefined;
  });
}

async function openSettings(settings: Record<string, string> = {}) {
  mockBackend(settings);
  render(
    <I18nProvider>
      <Settings onClose={() => {}} />
    </I18nProvider>,
  );
  await screen.findByRole("tablist", { name: "Settings" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_settings"));
}

const tabs = () => within(screen.getByRole("tablist", { name: "Settings" })).getAllByRole("tab");
const panel = () => screen.getByRole("tabpanel");
const saved = (key: string, value: string) => expect(invoke).toHaveBeenCalledWith("set_setting", { key, value });

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe("Settings: the tab list", () => {
  it("is a vertical tablist whose arrows move and select; the panel follows", async () => {
    await openSettings();
    const list = screen.getByRole("tablist", { name: "Settings" });
    expect(list).toHaveAttribute("aria-orientation", "vertical");
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
    expect(panel()).toHaveAccessibleName(tabs()[0].textContent ?? "");
    // One tab stop.
    expect(tabs().filter((t) => t.tabIndex === 0)).toHaveLength(1);

    fireEvent.keyDown(tabs()[0], { key: "ArrowDown" });
    expect(tabs()[1]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(panel()).toHaveAccessibleName(tabs()[1].textContent ?? "");

    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(tabs()[tabs().length - 1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs()[tabs().length - 1], { key: "Home" });
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("Settings: every on/off is a switch, every choice a select", () => {
  it("no tab has a checkbox or an unstyled select; each switch and select has a name", async () => {
    await openSettings();
    let switches = 0;
    let selects = 0;
    for (let i = 0; i < tabs().length; i++) {
      fireEvent.click(tabs()[i]);
      const p = panel();
      expect(p.querySelectorAll('input[type="checkbox"]'), `tab ${tabs()[i].textContent}`).toHaveLength(0);
      for (const sel of p.querySelectorAll("select")) {
        expect(sel.closest(".h-native-select"), `a select on ${tabs()[i].textContent}`).not.toBeNull();
        expect(sel).toHaveAccessibleName();
        selects++;
      }
      for (const sw of within(p).queryAllByRole("switch")) {
        expect(sw).toHaveAccessibleName();
        switches++;
      }
    }
    // General 3, Git 2 (+ turn history when its flag is on), Plugins 1, Privacy 1.
    expect(switches).toBeGreaterThanOrEqual(7);
    expect(selects).toBeGreaterThanOrEqual(12);
  });

  it("a switch shows the stored value and saves the flipped one at once", async () => {
    await openSettings({ status_strip: "off", git_auto_stage: "true" });
    const strip = await screen.findByRole("switch", { name: "Status line above agent sessions" });
    await waitFor(() => expect(strip).toHaveAttribute("aria-checked", "false"));
    fireEvent.click(strip);
    saved("status_strip", "on");
    expect(strip).toHaveAttribute("aria-checked", "true");

    // Inverted settings keep their meaning: "Confirm before closing" on = skip off.
    const confirm = screen.getByRole("switch", { name: /Confirm before closing/ });
    expect(confirm).toHaveAttribute("aria-checked", "true");
    fireEvent.click(confirm);
    saved("skip_close_confirm", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Git" }));
    const autoStage = screen.getByRole("switch", { name: /stage/i });
    expect(autoStage).toHaveAttribute("aria-checked", "true");
    fireEvent.click(autoStage);
    saved("git_auto_stage", "false");

    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    const analytics = screen.getByRole("switch", { name: /analytics/i });
    expect(analytics).toHaveAttribute("aria-checked", "false");
    fireEvent.click(analytics);
    saved("telemetry_enabled", "true");
  });

  it("a select is labelled by its visible label and saves the choice", async () => {
    await openSettings();
    const scrollback = screen.getByLabelText("Terminal Scrollback") as HTMLSelectElement;
    fireEvent.change(scrollback, { target: { value: "50000" } });
    saved("scrollback", "50000");
  });
});

describe("Settings: footer and header", () => {
  it("Export and Import are control-set buttons, and the close button is named", async () => {
    await openSettings();
    for (const name of ["Export Settings", "Import Settings"]) {
      const b = screen.getByRole("button", { name });
      expect(b).toHaveClass("h-btn", "h-btn--secondary");
    }
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("h-close-btn");
  });

  it("the current theme is a pressed chip; picking another saves it", async () => {
    await openSettings({ theme: "frosted-dark" });
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    const pressed = screen.getAllByRole("button", { pressed: true });
    expect(pressed).toHaveLength(1);
    const other = screen.getAllByRole("button", { pressed: false }).find((b) => b.closest(".settings-theme-item"));
    expect(other).toBeDefined();
    fireEvent.click(other!);
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === "set_setting" && (c[1] as { key: string }).key === "theme")).toBe(true));
  });
});
