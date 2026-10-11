// @vitest-environment jsdom
/**
 * The palette's "Check for Plugin Updates" toast is decided by what checkNow
 * returns: the number of updates the check found, or that it failed. Reading
 * the hook's state after the await saw the render before the check, so it
 * said "up to date" while the update banner was announcing one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const hostInvoke = vi.fn();
vi.mock("../plugins/identity", () => ({ hostInvoke: (...a: unknown[]) => hostInvoke(...a) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (key: string) => (key === "plugin_update_check" ? "never" : "")),
  setSetting: vi.fn(async () => {}),
}));
vi.mock("../plugins/pluginInstaller", () => ({ downloadAndInstallPlugin: vi.fn(async () => {}) }));
vi.mock("../plugins/PluginLoader", () => ({ PluginLoader: vi.fn() }));
vi.mock("../plugins/constants", () => ({ REGISTRY_URL: "https://registry.test", DEFAULT_PLUGINS: [] }));

import { usePluginUpdateChecker } from "../hooks/usePluginUpdateChecker";

const installed = [{ id: "p1", dir_name: "p1", manifest_json: JSON.stringify({ id: "p1", version: "1.0.0", name: "P1" }) }];

function registry(version: string) {
  return JSON.stringify({ plugins: [{ id: "p1", name: "P1", version, downloadUrl: "https://x/p1.tgz" }] });
}

beforeEach(() => {
  hostInvoke.mockReset();
});

describe("checkNow outcome", () => {
  it("reports the updates the check just found", async () => {
    hostInvoke.mockImplementation(async (cmd: string) => (cmd === "fetch_plugin_registry" ? registry("1.1.0") : installed));
    const { result, unmount } = renderHook(() => usePluginUpdateChecker());
    let outcome;
    await act(async () => { outcome = await result.current.checkNow(); });
    expect(outcome).toEqual({ failed: false, updates: 1 });
    expect(result.current.updatesAvailable).toHaveLength(1);
    unmount();
  });

  it("reports zero updates when everything is current", async () => {
    hostInvoke.mockImplementation(async (cmd: string) => (cmd === "fetch_plugin_registry" ? registry("1.0.0") : installed));
    const { result, unmount } = renderHook(() => usePluginUpdateChecker());
    let outcome;
    await act(async () => { outcome = await result.current.checkNow(); });
    expect(outcome).toEqual({ failed: false, updates: 0 });
    unmount();
  });

  it("reports a failure when the registry cannot be reached", async () => {
    hostInvoke.mockRejectedValue(new Error("offline"));
    const { result, unmount } = renderHook(() => usePluginUpdateChecker());
    let outcome;
    await act(async () => { outcome = await result.current.checkNow(); });
    expect(outcome).toEqual({ failed: true });
    unmount();
  });

  it("a check started while another runs waits for that one's outcome", async () => {
    let release!: (v: string) => void;
    hostInvoke.mockImplementation((cmd: string) =>
      cmd === "fetch_plugin_registry" ? new Promise<string>((r) => { release = r; }) : Promise.resolve(installed));
    const { result, unmount } = renderHook(() => usePluginUpdateChecker());
    let first: Promise<unknown>, second: Promise<unknown>;
    await act(async () => {
      first = result.current.checkNow();
      second = result.current.checkNow();
      release(registry("2.0.0"));
      await Promise.all([first, second]);
    });
    await expect(second!).resolves.toEqual({ failed: false, updates: 1 });
    expect(hostInvoke.mock.calls.filter(([c]) => c === "fetch_plugin_registry")).toHaveLength(1);
    unmount();
  });
});
