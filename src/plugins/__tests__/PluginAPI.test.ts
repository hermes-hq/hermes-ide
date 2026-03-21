import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPluginAPI, PermissionDeniedError, type PluginAPICallbacks } from "../PluginAPI";

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

describe("createPluginAPI", () => {
	let callbacks: PluginAPICallbacks;
	let commandHandlers: Map<string, () => void | Promise<void>>;
	let panelComponents: Map<string, React.ComponentType<any>>;

	beforeEach(() => {
		callbacks = createMockCallbacks();
		commandHandlers = new Map();
		panelComponents = new Map();
		mockInvoke.mockReset();
	});

	describe("permissions", () => {
		it("should allow clipboard read when permission is granted", async () => {
			const api = createPluginAPI("test", new Set(["clipboard.read"]), undefined, callbacks, commandHandlers, panelComponents);
			expect(() => api.clipboard.readText()).not.toThrow(PermissionDeniedError);
		});

		it("should deny clipboard read when permission is not granted", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			expect(() => api.clipboard.readText()).toThrow(PermissionDeniedError);
		});

		it("should deny clipboard write when permission is not granted", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			expect(() => api.clipboard.writeText("test")).toThrow(PermissionDeniedError);
		});

		it("should deny storage when permission is not granted", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.storage.get("key")).rejects.toThrow(PermissionDeniedError);
		});

		it("should allow storage when permission is granted", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("test", new Set(["storage"]), undefined, callbacks, commandHandlers, panelComponents);
			await api.storage.set("key", "value");
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", { pluginId: "test", key: "key", value: "value" });
		});
	});

	describe("commands", () => {
		it("should register command handlers", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			const handler = vi.fn();
			api.commands.register("test.cmd", handler);
			expect(commandHandlers.has("test.cmd")).toBe(true);
		});

		it("should dispose command handlers", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			const handler = vi.fn();
			const disposable = api.commands.register("test.cmd", handler);
			disposable.dispose();
			expect(commandHandlers.has("test.cmd")).toBe(false);
		});

		it("should execute command handlers", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			const handler = vi.fn();
			api.commands.register("test.cmd", handler);
			await api.commands.execute("test.cmd");
			expect(handler).toHaveBeenCalledOnce();
		});
	});

	describe("ui", () => {
		it("should register panel components", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			const Component = () => null;
			api.ui.registerPanel("panel-1", Component as any);
			expect(panelComponents.get("panel-1")).toBe(Component);
		});

		it("should call onPanelShow callback", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			api.ui.showPanel("panel-1");
			expect(callbacks.onPanelShow).toHaveBeenCalledWith("panel-1");
		});

		it("should call onPanelHide callback", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			api.ui.hidePanel("panel-1");
			expect(callbacks.onPanelHide).toHaveBeenCalledWith("panel-1");
		});

		it("should call onToast callback with duration", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			api.ui.showToast("Hello", { type: "success", duration: 5000 });
			expect(callbacks.onToast).toHaveBeenCalledWith("Hello", "success", 5000);
		});

		it("should call onToast with default type and undefined duration", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			api.ui.showToast("Hello");
			expect(callbacks.onToast).toHaveBeenCalledWith("Hello", "info", undefined);
		});

		it("should call onStatusBarUpdate callback", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			api.ui.updateStatusBarItem("item-1", { text: "Updated" });
			expect(callbacks.onStatusBarUpdate).toHaveBeenCalledWith("item-1", { text: "Updated" });
		});
	});

	describe("events", () => {
		it("events.on() should delegate to onEventSubscribe callback", () => {
			const mockDisposable = { dispose: vi.fn() };
			const onEventSubscribe = vi.fn().mockReturnValue(mockDisposable);
			const cb = createMockCallbacks();
			cb.onEventSubscribe = onEventSubscribe;

			const api = createPluginAPI("test", new Set(), undefined, cb, commandHandlers, panelComponents);
			const listener = vi.fn();
			const result = api.events.on("theme.changed", listener);

			expect(onEventSubscribe).toHaveBeenCalledWith("theme.changed", listener);
			expect(result).toBe(mockDisposable);
		});

		it("events.on() should return no-op disposable when no onEventSubscribe", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			const listener = vi.fn();
			const disposable = api.events.on("theme.changed", listener);

			expect(disposable).toBeDefined();
			expect(() => disposable.dispose()).not.toThrow();
		});
	});

	describe("notifications", () => {
		it("should throw without permission", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.notifications.send({ title: "Hello" })).rejects.toThrow(PermissionDeniedError);
		});

		it("should call onNotification with permission", async () => {
			const onNotification = vi.fn().mockResolvedValue(undefined);
			const cb = createMockCallbacks();
			cb.onNotification = onNotification;

			const api = createPluginAPI("test", new Set(["notifications"]), undefined, cb, commandHandlers, panelComponents);
			await api.notifications.send({ title: "Hello", body: "World" });
			expect(onNotification).toHaveBeenCalledWith({ title: "Hello", body: "World" });
		});

		it("should succeed silently with permission but no onNotification callback", async () => {
			const api = createPluginAPI("test", new Set(["notifications"]), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.notifications.send({ title: "Hello" })).resolves.toBeUndefined();
		});
	});

	describe("sessions", () => {
		it("getActive() should throw without permission", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.sessions.getActive()).rejects.toThrow(PermissionDeniedError);
		});

		it("list() should throw without permission", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.sessions.list()).rejects.toThrow(PermissionDeniedError);
		});

		it("getActive() should work with permission and callback", async () => {
			const session = { id: "s1", name: "Session 1" };
			const onSessionsGetActive = vi.fn().mockResolvedValue(session);
			const cb = createMockCallbacks();
			cb.onSessionsGetActive = onSessionsGetActive;

			const api = createPluginAPI("test", new Set(["sessions.read"]), undefined, cb, commandHandlers, panelComponents);
			const result = await api.sessions.getActive();
			expect(result).toEqual(session);
			expect(onSessionsGetActive).toHaveBeenCalledOnce();
		});

		it("getActive() should return null with permission but no callback", async () => {
			const api = createPluginAPI("test", new Set(["sessions.read"]), undefined, callbacks, commandHandlers, panelComponents);
			const result = await api.sessions.getActive();
			expect(result).toBeNull();
		});

		it("list() should work with permission and callback", async () => {
			const sessions = [{ id: "s1", name: "Session 1" }, { id: "s2", name: "Session 2" }];
			const onSessionsList = vi.fn().mockResolvedValue(sessions);
			const cb = createMockCallbacks();
			cb.onSessionsList = onSessionsList;

			const api = createPluginAPI("test", new Set(["sessions.read"]), undefined, cb, commandHandlers, panelComponents);
			const result = await api.sessions.list();
			expect(result).toEqual(sessions);
			expect(onSessionsList).toHaveBeenCalledOnce();
		});

		it("list() should return empty array with permission but no callback", async () => {
			const api = createPluginAPI("test", new Set(["sessions.read"]), undefined, callbacks, commandHandlers, panelComponents);
			const result = await api.sessions.list();
			expect(result).toEqual([]);
		});
	});

	describe("storage", () => {
		it("should call Tauri invoke for storage get", async () => {
			mockInvoke.mockResolvedValue("stored-value");
			const api = createPluginAPI("my-plugin", new Set(["storage"]), undefined, callbacks, commandHandlers, panelComponents);
			const result = await api.storage.get("key");
			expect(result).toBe("stored-value");
			expect(mockInvoke).toHaveBeenCalledWith("get_plugin_setting", { pluginId: "my-plugin", key: "key" });
		});

		it("should call Tauri invoke for storage set", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("my-plugin", new Set(["storage"]), undefined, callbacks, commandHandlers, panelComponents);
			await api.storage.set("key", "value");
			expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", { pluginId: "my-plugin", key: "key", value: "value" });
		});

		it("should call Tauri invoke for storage delete", async () => {
			mockInvoke.mockResolvedValue(undefined);
			const api = createPluginAPI("my-plugin", new Set(["storage"]), undefined, callbacks, commandHandlers, panelComponents);
			await api.storage.delete("key");
			expect(mockInvoke).toHaveBeenCalledWith("delete_plugin_setting", { pluginId: "my-plugin", key: "key" });
		});
	});

	describe("settings permission enforcement", () => {
		const testSchema = {
			fontSize: { type: "number" as const, title: "Font Size", default: 14, min: 8, max: 72, step: 1 },
		};

		it("settings.get() should throw without storage permission", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);
			await expect(api.settings.get("fontSize")).rejects.toThrow(PermissionDeniedError);
		});

		it("settings.update() should throw without storage permission", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);
			await expect(api.settings.update("fontSize", 16)).rejects.toThrow(PermissionDeniedError);
		});

		it("settings.getAll() should throw without storage permission", async () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);
			await expect(api.settings.getAll()).rejects.toThrow(PermissionDeniedError);
		});

		it("settings.onDidChange() should throw without storage permission", () => {
			const api = createPluginAPI("test", new Set(), testSchema, callbacks, commandHandlers, panelComponents);
			expect(() => api.settings.onDidChange("fontSize", vi.fn())).toThrow(PermissionDeniedError);
		});
	});

	describe("network", () => {
		it("network.fetch should pass pluginId to invoke", async () => {
			mockInvoke.mockResolvedValue("response body");
			const api = createPluginAPI("my-plugin", new Set(["network"]), undefined, callbacks, commandHandlers, panelComponents);
			await api.network.fetch("https://example.com");
			expect(mockInvoke).toHaveBeenCalledWith("plugin_fetch_url", { url: "https://example.com", headers: null, pluginId: "my-plugin" });
		});

		it("network.fetch should throw without network permission", () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			expect(() => api.network.fetch("https://example.com")).toThrow(PermissionDeniedError);
		});
	});

	describe("shell.exec", () => {
		it("should pass command and args to invoke with pluginId", async () => {
			mockInvoke.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
			const api = createPluginAPI("my-plugin", new Set(["shell.exec"]), undefined, callbacks, commandHandlers, panelComponents);
			const result = await api.shell.exec("echo", ["hello"]);
			expect(mockInvoke).toHaveBeenCalledWith("plugin_exec_command", { command: "echo", args: ["hello"], pluginId: "my-plugin" });
			expect(result.stdout).toBe("output");
		});

		it("should throw without shell.exec permission", async () => {
			const api = createPluginAPI("test", new Set(), undefined, callbacks, commandHandlers, panelComponents);
			await expect(api.shell.exec("echo", ["hello"])).rejects.toThrow(PermissionDeniedError);
		});

		it("should default args to empty array", async () => {
			mockInvoke.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
			const api = createPluginAPI("my-plugin", new Set(["shell.exec"]), undefined, callbacks, commandHandlers, panelComponents);
			await api.shell.exec("whoami");
			expect(mockInvoke).toHaveBeenCalledWith("plugin_exec_command", { command: "whoami", args: [], pluginId: "my-plugin" });
		});
	});
});
