import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginLoader } from "../PluginLoader";
import { PluginRuntime } from "../PluginRuntime";
import type { PluginAPICallbacks } from "../PluginAPI";
import { _resetPluginIdentityForTests } from "../identity";
import { HOST_KEY } from "./identityMock";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function createMockCallbacks(): PluginAPICallbacks {
	return {
		onPanelToggle: vi.fn(),
		onPanelShow: vi.fn(),
		onPanelHide: vi.fn(),
		onToast: vi.fn(),
		onStatusBarUpdate: vi.fn(),
	};
}

describe("PluginLoader", () => {
	let runtime: PluginRuntime;
	let loader: PluginLoader;

	beforeEach(() => {
		runtime = new PluginRuntime(createMockCallbacks());
		loader = new PluginLoader(runtime);
		mockInvoke.mockReset();
		_resetPluginIdentityForTests();

		// Clean up global state
		if ((globalThis as any).__hermesPlugins) {
			delete (globalThis as any).__hermesPlugins;
		}
	});

	it("should handle empty plugins directory", async () => {
		mockInvoke.mockResolvedValue([]);
		await loader.loadAllPlugins();
		expect(runtime.getPluginCount()).toBe(0);
	});

	it("should handle list_installed_plugins failure gracefully", async () => {
		mockInvoke.mockRejectedValue(new Error("Dir not found"));
		await loader.loadAllPlugins();
		expect(runtime.getPluginCount()).toBe(0);
	});

	it("should track loaded plugin IDs", async () => {
		mockInvoke.mockResolvedValue([]);
		await loader.loadAllPlugins();
		expect(loader.getLoadedPlugins().size).toBe(0);
	});

	it("should skip plugins with invalid manifest JSON", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "claim_plugin_host_key") return HOST_KEY;
			if (cmd === "list_installed_plugins") {
				return [{
					id: "bad-plugin",
					dir_name: "bad-plugin",
					manifest_json: "NOT VALID JSON",
				}];
			}
			return "";
		});

		await loader.loadAllPlugins();
		expect(runtime.getPluginCount()).toBe(0);
	});
});
