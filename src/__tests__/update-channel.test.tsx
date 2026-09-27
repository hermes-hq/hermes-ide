// @vitest-environment jsdom
/**
 * Update channel (stable / beta): the API wrapper the auto-updater uses and
 * the Settings control that stores the choice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {
    metadata: unknown;
    constructor(metadata: unknown) {
      this.metadata = metadata;
    }
  },
}));
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
vi.mock("../components/ShortcutsPanel", () => ({ SHORTCUT_GROUPS: [] }));

import { checkForUpdate, getUpdateChannelInfo, normalizeUpdateChannel } from "../api/updater";
import { Update } from "@tauri-apps/plugin-updater";
import { I18nProvider } from "../i18n/I18nProvider";
import { Settings } from "../components/Settings";

describe("normalizeUpdateChannel", () => {
  it("treats anything but beta as stable", () => {
    expect(normalizeUpdateChannel(undefined)).toBe("stable");
    expect(normalizeUpdateChannel("")).toBe("stable");
    expect(normalizeUpdateChannel("nightly")).toBe("stable");
    expect(normalizeUpdateChannel("stable")).toBe("stable");
  });

  it("accepts beta loosely", () => {
    expect(normalizeUpdateChannel("beta")).toBe("beta");
    expect(normalizeUpdateChannel(" BETA ")).toBe("beta");
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the backend, which knows the channel, not the plugin directly", async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await checkForUpdate()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("check_for_update");
  });

  it("wraps the backend result in the plugin's Update so download/install keep working", async () => {
    invoke.mockResolvedValueOnce({
      rid: 7,
      currentVersion: "1.4.0",
      version: "1.4.1",
      date: null,
      body: "notes",
      rawJson: { version: "1.4.1" },
    });
    const update = await checkForUpdate();
    expect(update).toBeInstanceOf(Update);
    expect((update as unknown as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      rid: 7,
      currentVersion: "1.4.0",
      version: "1.4.1",
      body: "notes",
    });
  });

  it("reports the channel the backend resolved", async () => {
    invoke.mockResolvedValueOnce({ channel: "beta", endpoint: "https://example.test/beta.json", disabled: false });
    expect(await getUpdateChannelInfo()).toEqual({
      channel: "beta",
      endpoint: "https://example.test/beta.json",
      disabled: false,
    });
    expect(invoke).toHaveBeenCalledWith("get_update_channel_info");
  });
});

describe("Settings > Update channel", () => {
  beforeEach(() => {
    cleanup();
    invoke.mockReset();
  });

  function mockBackend(settings: Record<string, string>) {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return settings;
      if (cmd === "get_available_shells") return [];
      if (cmd === "set_setting") return undefined;
      return undefined;
    });
  }

  it("shows stable when nothing was chosen yet", async () => {
    mockBackend({});
    render(
      <I18nProvider>
        <Settings onClose={() => {}} />
      </I18nProvider>,
    );
    const select = (await screen.findByLabelText("Update channel")) as HTMLSelectElement;
    expect(select.value).toBe("stable");
    expect([...select.options].map((o) => o.value)).toEqual(["stable", "beta"]);
  });

  it("shows the stored choice", async () => {
    mockBackend({ update_channel: "beta" });
    render(
      <I18nProvider>
        <Settings onClose={() => {}} />
      </I18nProvider>,
    );
    const select = (await screen.findByLabelText("Update channel")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("beta"));
  });

  it("stores the new channel when the user picks one", async () => {
    mockBackend({});
    render(
      <I18nProvider>
        <Settings onClose={() => {}} />
      </I18nProvider>,
    );
    const select = (await screen.findByLabelText("Update channel")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "beta" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_setting", { key: "update_channel", value: "beta" }));
    expect(select.value).toBe("beta");

    fireEvent.change(select, { target: { value: "stable" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", { key: "update_channel", value: "stable" }),
    );
  });
});
