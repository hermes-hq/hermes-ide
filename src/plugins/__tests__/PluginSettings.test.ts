import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPluginAPI, type PluginAPICallbacks } from "../PluginAPI";
import type { PluginSettingsSchema } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function createMockCallbacks(overrides?: Partial<PluginAPICallbacks>): PluginAPICallbacks {
	return {
		onPanelToggle: vi.fn(),
		onPanelShow: vi.fn(),
		onPanelHide: vi.fn(),
		onToast: vi.fn(),
		onStatusBarUpdate: vi.fn(),
		...overrides,
	};
}

const testSchema: PluginSettingsSchema = {
	fontSize: {
		type: "number",
		title: "Font Size",
		description: "Editor font size in pixels",
		default: 14,
		min: 8,
		max: 72,
		step: 1,
	},
	theme: {
		type: "select",
		title: "Theme",
		default: "dark",
		options: [
			{ value: "dark", label: "Dark" },
			{ value: "light", label: "Light" },
			{ value: "auto", label: "Auto" },
		],
	},
	showLineNumbers: {
		type: "boolean",
		title: "Show Line Numbers",
		default: true,
	},
	greeting: {
		type: "string",
		title: "Greeting Message",
		default: "Hello",
		placeholder: "Enter a greeting...",
	},
};

describe("Plugin Settings", () => {
	let callbacks: PluginAPICallbacks;
	let commandHandlers: Map<string, () => void | Promise<void>>;
	let panelComponents: Map<string, React.ComponentType<any>>;

	beforeEach(() => {
		callbacks = createMockCallbacks();
		commandHandlers = new Map();
		panelComponents = new Map();
		mockInvoke.mockReset();
	});

	describe("settings.get()", () => {
		it("should return default from schema when no stored value", async () => {
			mockInvoke.mockResolvedValue(null);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const fontSize = await api.settings.get<number>("fontSize");
			expect(fontSize).toBe(14);
			expect(mockInvoke).toHaveBeenCalledWith("get_plugin_setting", {
				pluginId: "test",
				key: "__setting:fontSize",
			});
		});

		it("should return stored value when it exists", async () => {
			mockInvoke.mockResolvedValue("20");
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const fontSize = await api.settings.get<number>("fontSize");
			expect(fontSize).toBe(20);
		});

		it("should coerce number values from string", async () => {
			mockInvoke.mockResolvedValue("3.14");
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const fontSize = await api.settings.get<number>("fontSize");
			expect(fontSize).toBe(3.14);
			expect(typeof fontSize).toBe("number");
		});

		it("should coerce boolean values from string", async () => {
			mockInvoke.mockResolvedValue("true");
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get<boolean>("showLineNumbers");
			expect(val).toBe(true);
			expect(typeof val).toBe("boolean");
		});

		it("should coerce boolean false from string", async () => {
			mockInvoke.mockResolvedValue("false");
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get<boolean>("showLineNumbers");
			expect(val).toBe(false);
			expect(typeof val).toBe("boolean");
		});

		it("should return string values as-is", async () => {
			mockInvoke.mockResolvedValue("Howdy");
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get<string>("greeting");
			expect(val).toBe("Howdy");
		});

		it("should return undefined for unknown key", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get("nonexistent");
			expect(val).toBeUndefined();
		});

		it("should return default when stored value is undefined", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get<boolean>("showLineNumbers");
			expect(val).toBe(true);
		});
	});

	describe("settings.update()", () => {
		it("should validate key exists in schema", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("unknownKey", "value")).rejects.toThrow(
				'Plugin "test": unknown setting key "unknownKey".',
			);
		});

		it("should validate number min", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("fontSize", 2)).rejects.toThrow(
				'value 2 is below minimum 8',
			);
		});

		it("should validate number max", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("fontSize", 100)).rejects.toThrow(
				'value 100 is above maximum 72',
			);
		});

		it("should validate select options", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("theme", "neon")).rejects.toThrow(
				'value "neon" is not a valid option',
			);
		});

		it("should validate type mismatch for number", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("fontSize", "not-a-number")).rejects.toThrow(
				'expects a number, got string',
			);
		});

		it("should validate type mismatch for boolean", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("showLineNumbers", "yes")).rejects.toThrow(
				'expects a boolean, got string',
			);
		});

		it("should validate type mismatch for string", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("greeting", 42)).rejects.toThrow(
				'expects a string, got number',
			);
		});

		it("should write to storage with __setting: prefix", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await api.settings.update("fontSize", 16);
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", {
				pluginId: "test",
				key: "__setting:fontSize",
				value: "16",
			});
		});

		it("should stringify boolean values for storage", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await api.settings.update("showLineNumbers", false);
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", {
				pluginId: "test",
				key: "__setting:showLineNumbers",
				value: "false",
			});
		});

		it("should call onSettingChanged callback", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const onSettingChanged = vi.fn();
			callbacks = createMockCallbacks({ onSettingChanged });
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await api.settings.update("fontSize", 18);
			expect(onSettingChanged).toHaveBeenCalledWith("test", "fontSize", 18);
		});

		it("should accept valid select option", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await api.settings.update("theme", "light");
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", {
				pluginId: "test",
				key: "__setting:theme",
				value: "light",
			});
		});

		it("should accept valid number within range", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			await api.settings.update("fontSize", 36);
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", {
				pluginId: "test",
				key: "__setting:fontSize",
				value: "36",
			});
		});

		it("should notify local onDidChange listeners", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener = vi.fn();
			api.settings.onDidChange("fontSize", listener);

			await api.settings.update("fontSize", 20);
			expect(listener).toHaveBeenCalledWith(20);
		});
	});

	describe("settings.onDidChange()", () => {
		it("should return a disposable", () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const disposable = api.settings.onDidChange("fontSize", vi.fn());
			expect(disposable).toBeDefined();
			expect(typeof disposable.dispose).toBe("function");
		});

		it("should stop receiving updates after dispose", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener = vi.fn();
			const disposable = api.settings.onDidChange("fontSize", listener);
			disposable.dispose();

			await api.settings.update("fontSize", 24);
			expect(listener).not.toHaveBeenCalled();
		});

		it("should support multiple listeners on the same key", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener1 = vi.fn();
			const listener2 = vi.fn();
			api.settings.onDidChange("fontSize", listener1);
			api.settings.onDidChange("fontSize", listener2);

			await api.settings.update("fontSize", 30);
			expect(listener1).toHaveBeenCalledWith(30);
			expect(listener2).toHaveBeenCalledWith(30);
		});

		it("disposing one listener should not affect others", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener1 = vi.fn();
			const listener2 = vi.fn();
			const disposable1 = api.settings.onDidChange("fontSize", listener1);
			api.settings.onDidChange("fontSize", listener2);

			disposable1.dispose();
			await api.settings.update("fontSize", 28);

			expect(listener1).not.toHaveBeenCalled();
			expect(listener2).toHaveBeenCalledWith(28);
		});
	});

	describe("settings.getAll()", () => {
		it("should merge stored values with defaults", async () => {
			mockInvoke.mockImplementation((_cmd, args) => {
				const key = (args as { key: string }).key;
				if (key === "__setting:fontSize") return Promise.resolve("20");
				if (key === "__setting:theme") return Promise.resolve("light");
				return Promise.resolve(null);
			});

			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const all = await api.settings.getAll();
			expect(all).toEqual({
				fontSize: 20,
				theme: "light",
				showLineNumbers: true, // default
				greeting: "Hello", // default
			});
		});

		it("should return all defaults when nothing is stored", async () => {
			mockInvoke.mockResolvedValue(null);
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const all = await api.settings.getAll();
			expect(all).toEqual({
				fontSize: 14,
				theme: "dark",
				showLineNumbers: true,
				greeting: "Hello",
			});
		});

		it("should coerce types correctly in getAll", async () => {
			mockInvoke.mockImplementation((_cmd, args) => {
				const key = (args as { key: string }).key;
				if (key === "__setting:fontSize") return Promise.resolve("24");
				if (key === "__setting:showLineNumbers") return Promise.resolve("false");
				return Promise.resolve(null);
			});

			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const all = await api.settings.getAll();
			expect(all.fontSize).toBe(24);
			expect(typeof all.fontSize).toBe("number");
			expect(all.showLineNumbers).toBe(false);
			expect(typeof all.showLineNumbers).toBe("boolean");
		});
	});

	describe("storage.__setting: prefix reservation", () => {
		it("storage.set() should reject keys starting with __setting:", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(["storage"]), testSchema, callbacks, commandHandlers, panelComponents);

			await expect(api.storage.set("__setting:fontSize", "20")).rejects.toThrow(
				'storage key "__setting:fontSize" is reserved',
			);
		});

		it("storage.set() should allow normal keys", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(["storage"]), testSchema, callbacks, commandHandlers, panelComponents);

			await api.storage.set("myData", "value");
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", {
				pluginId: "test",
				key: "myData",
				value: "value",
			});
		});
	});

	describe("_notifySettingChanged (external trigger)", () => {
		it("should notify onDidChange listeners when called externally", () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener = vi.fn();
			api.settings.onDidChange("fontSize", listener);

			api._notifySettingChanged("fontSize", 24);
			expect(listener).toHaveBeenCalledWith(24);
		});

		it("should not throw when no listeners registered for key", () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			expect(() => api._notifySettingChanged("fontSize", 24)).not.toThrow();
		});

		it("should not call disposed listeners", () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);

			const listener = vi.fn();
			const disposable = api.settings.onDidChange("fontSize", listener);
			disposable.dispose();

			api._notifySettingChanged("fontSize", 24);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("settings without schema", () => {
		it("settings.get() should return undefined when no schema", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);

			const val = await api.settings.get("anything");
			expect(val).toBeUndefined();
		});

		it("settings.update() should throw for any key when no schema", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);

			await expect(api.settings.update("anything", "value")).rejects.toThrow(
				'unknown setting key "anything"',
			);
		});

		it("settings.getAll() should return empty object when no schema", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);

			const all = await api.settings.getAll();
			expect(all).toEqual({});
		});

		it("settings.onDidChange() should return a disposable when no schema", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);

			const disposable = api.settings.onDidChange("anything", vi.fn());
			expect(disposable).toBeDefined();
			expect(typeof disposable.dispose).toBe("function");
			expect(() => disposable.dispose()).not.toThrow();
		});
	});
});
