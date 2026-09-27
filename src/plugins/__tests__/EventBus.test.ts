import { describe, it, expect, vi, beforeEach } from "vitest";

// Activation talks to the backend (plugin identity, metadata); stand it in.
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { PluginRuntime, type PluginModule } from "../PluginRuntime";
import { createPluginAPI, type PluginAPICallbacks } from "../PluginAPI";
import type { HermesEvent } from "../types";
import { _resetPluginIdentityForTests } from "../identity";
import { identityInvoke } from "./identityMock";

/**
 * Tests for the event bus system implemented in PluginRuntime.
 * The runtime's subscribeEvent / emitEvent methods form the event bus
 * that plugins interact with via api.events.on().
 */

function createMockCallbacks(): PluginAPICallbacks {
	return {
		onPanelToggle: vi.fn(),
		onPanelShow: vi.fn(),
		onPanelHide: vi.fn(),
		onToast: vi.fn(),
		onStatusBarUpdate: vi.fn(),
	};
}

function createEventPlugin(
	activateFn: (api: any) => void | Promise<void>,
): PluginModule {
	return {
		manifest: {
			id: "event.plugin",
			name: "Event Plugin",
			version: "1.0.0",
			description: "Plugin for event testing",
			author: "Test",
			activationEvents: [{ type: "onStartup" }],
			contributes: {},
			permissions: [],
		},
		activate: activateFn,
	};
}

describe("EventBus (PluginRuntime event system)", () => {
	let runtime: PluginRuntime;

	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		vi.mocked(invoke).mockImplementation(identityInvoke);
		_resetPluginIdentityForTests();
		runtime = new PluginRuntime(createMockCallbacks());
	});

	it("on() should register a listener and return a disposable", async () => {
		let disposable: { dispose(): void } | undefined;
		const listener = vi.fn();

		const plugin = createEventPlugin((api) => {
			disposable = api.events.on("theme.changed" as HermesEvent, listener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		expect(disposable).toBeDefined();
		expect(typeof disposable!.dispose).toBe("function");
	});

	it("emit() should call registered listeners with args", async () => {
		const listener = vi.fn();

		const plugin = createEventPlugin((api) => {
			api.events.on("session.created" as HermesEvent, listener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		runtime.emitEvent("session.created", "arg1", 42);
		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith("arg1", 42);
	});

	it("emit() should not throw when a listener throws (error isolation)", async () => {
		const badListener = vi.fn(() => {
			throw new Error("Listener blew up");
		});
		const goodListener = vi.fn();

		const plugin = createEventPlugin((api) => {
			api.events.on("theme.changed" as HermesEvent, badListener);
			api.events.on("theme.changed" as HermesEvent, goodListener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		expect(() => runtime.emitEvent("theme.changed")).not.toThrow();
		expect(badListener).toHaveBeenCalledOnce();
		expect(goodListener).toHaveBeenCalledOnce();
	});

	it("dispose() should remove the listener", async () => {
		const listener = vi.fn();
		let disposable: { dispose(): void };

		const plugin = createEventPlugin((api) => {
			disposable = api.events.on("window.focused" as HermesEvent, listener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		disposable!.dispose();
		runtime.emitEvent("window.focused");
		expect(listener).not.toHaveBeenCalled();
	});

	it("multiple listeners on the same event should all fire", async () => {
		const listener1 = vi.fn();
		const listener2 = vi.fn();
		const listener3 = vi.fn();

		const plugin = createEventPlugin((api) => {
			api.events.on("session.closed" as HermesEvent, listener1);
			api.events.on("session.closed" as HermesEvent, listener2);
			api.events.on("session.closed" as HermesEvent, listener3);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		runtime.emitEvent("session.closed", "session-123");
		expect(listener1).toHaveBeenCalledWith("session-123");
		expect(listener2).toHaveBeenCalledWith("session-123");
		expect(listener3).toHaveBeenCalledWith("session-123");
	});

	it("listeners on different events should not interfere", async () => {
		const themeListener = vi.fn();
		const sessionListener = vi.fn();

		const plugin = createEventPlugin((api) => {
			api.events.on("theme.changed" as HermesEvent, themeListener);
			api.events.on("session.created" as HermesEvent, sessionListener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		runtime.emitEvent("theme.changed", "dark");
		expect(themeListener).toHaveBeenCalledWith("dark");
		expect(sessionListener).not.toHaveBeenCalled();

		runtime.emitEvent("session.created", "s1");
		expect(sessionListener).toHaveBeenCalledWith("s1");
		expect(themeListener).toHaveBeenCalledOnce(); // still only the one call
	});

	it("emit on event with no listeners should be a no-op", () => {
		// No plugins registered, no listeners — should not throw
		expect(() => runtime.emitEvent("window.blurred")).not.toThrow();
	});

	it("disposing the only listener should clean up the event entry", async () => {
		const listener = vi.fn();
		let disposable: { dispose(): void };

		const plugin = createEventPlugin((api) => {
			disposable = api.events.on("window.blurred" as HermesEvent, listener);
		});
		runtime.register(plugin);
		await runtime.activate("event.plugin");

		disposable!.dispose();
		// After disposing the only listener, emitting should be a silent no-op
		runtime.emitEvent("window.blurred");
		expect(listener).not.toHaveBeenCalled();
	});

	it("events.on() without onEventSubscribe callback should return a no-op disposable", () => {
		// Directly create an API without the onEventSubscribe callback
		// to test the fallback path
		const api = createPluginAPI(
			"test",
			"tok-test",
			new Set<string>(),
			undefined,
			createMockCallbacks(), // no onEventSubscribe
			new Map(),
			new Map(),
		);
		const listener = vi.fn();
		const disposable = api.events.on("theme.changed", listener);
		expect(disposable).toBeDefined();
		expect(typeof disposable.dispose).toBe("function");
		// dispose should not throw
		expect(() => disposable.dispose()).not.toThrow();
	});
});
