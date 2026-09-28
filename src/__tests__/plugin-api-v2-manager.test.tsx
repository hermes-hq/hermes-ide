// @vitest-environment jsdom
/**
 * F36 — what Settings > Plugins shows about the plugin API:
 *   - with plugin API v2 on, a plugin built for v1 is marked "old API" and
 *     its details say when it stops loading; a v2 plugin is not marked;
 *   - with v2 off (stable), nothing is marked, and a v2 plugin says it is
 *     not loaded and why;
 *   - the review checks a plugin registered are listed under it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "2.1.0") }));

import { PluginManager } from "../components/PluginManager";
import { I18nProvider } from "../i18n/I18nProvider";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import { _resetPluginIdentityForTests } from "../plugins/identity";
import { _resetReviewChecksForTest, registerReviewCheck } from "../agent/contract/reviewChecks";

const manifest = (id: string, name: string, apiVersion?: number) =>
  JSON.stringify({
    id,
    name,
    version: "1.0.0",
    description: `${name} description`,
    author: "Test",
    activationEvents: [{ type: "onStartup" }],
    contributes: {},
    permissions: ["sessions.read"],
    ...(apiVersion === undefined ? {} : { apiVersion }),
  });

beforeEach(() => {
  _resetPluginIdentityForTests();
  _resetReviewChecksForTest();
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "claim_plugin_host_key":
        return "host-key";
      case "list_installed_plugins":
        return [
          { id: "old.plugin", dir_name: "old.plugin", manifest_json: manifest("old.plugin", "Old Plugin") },
          { id: "new.plugin", dir_name: "new.plugin", manifest_json: manifest("new.plugin", "New Plugin", 2) },
        ];
      case "get_plugins_dir":
        return "/work/plugins";
      case "get_disabled_plugin_ids":
        return [];
      case "fetch_plugin_registry":
        throw new Error("offline");
      default:
        return null;
    }
  });
});

afterEach(() => {
  cleanup();
  __resetFeatureFlagsForTest();
});

async function show(v2: boolean) {
  __resetFeatureFlagsForTest();
  await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ pluginApiV2: v2 }) });
  render(
    <I18nProvider>
      <PluginManager />
    </I18nProvider>,
  );
  await waitFor(() => expect(screen.getByText("Old Plugin")).toBeTruthy());
}

const row = (id: string) => document.querySelector(`[data-plugin-row="${id}"]`) as HTMLElement;

describe("plugin API in Settings > Plugins", () => {
  it("v2 on: the v1 plugin is marked as using the old API, with the release that drops it", async () => {
    await show(true);
    expect(within(row("old.plugin")).getByText("old API")).toBeTruthy();
    expect(within(row("new.plugin")).queryByText("old API")).toBeNull();
    expect(within(row("new.plugin")).queryByText("not loaded")).toBeNull();

    fireEvent.click(screen.getByText("Old Plugin"));
    const note = within(row("old.plugin")).getByRole("note");
    expect(note.textContent).toBe(
      "Built for the old plugin API (v1). It still works, but Hermes 2.2 stops loading it: ask the author for an update.",
    );
    expect(row("old.plugin").textContent).toContain("Plugin API: v1");
  });

  it("v2 off: nothing is marked old, and the v2 plugin says it is not loaded and why", async () => {
    await show(false);
    expect(screen.queryByText("old API")).toBeNull();
    expect(within(row("new.plugin")).getByText("not loaded")).toBeTruthy();
    fireEvent.click(screen.getByText("New Plugin"));
    expect(within(row("new.plugin")).getByRole("note").textContent).toBe(
      "Needs plugin API v2, which this version of Hermes does not turn on yet.",
    );
    expect(row("new.plugin").textContent).not.toContain("Plugin API:");
  });

  it("lists the review checks a plugin registered, live", async () => {
    await show(true);
    fireEvent.click(screen.getByText("New Plugin"));
    expect(within(row("new.plugin")).queryByText("Review checks")).toBeNull();
    act(() => {
      registerReviewCheck("plugin:new.plugin", {
        id: "license-scan",
        title: "License scan",
        description: "Flags copyleft licenses",
        run: () => ({ outcome: "pass", summary: "", findings: [] }),
      });
      registerReviewCheck("plugin:someone.else", { id: "x", title: "Not mine", run: () => ({ outcome: "pass", summary: "", findings: [] }) });
    });
    const detail = row("new.plugin");
    expect(within(detail).getByText("Review checks")).toBeTruthy();
    expect(within(detail).getByText("License scan")).toBeTruthy();
    expect(within(detail).getByText("Flags copyleft licenses")).toBeTruthy();
    expect(within(detail).queryByText("Not mine")).toBeNull();
  });
});
