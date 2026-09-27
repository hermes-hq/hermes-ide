/**
 * Behaviour of the plugin-identity binding across runtime, loader and API:
 * a plugin's calls carry its own token, nothing else; the runtime keeps the
 * token out of reach of other plugins; and no plugin code runs before the
 * host holds its key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { PluginRuntime, type PluginModule } from "../PluginRuntime";
import { PluginLoader } from "../PluginLoader";
import { createPluginAPI, type HermesPluginAPI, type PluginAPICallbacks } from "../PluginAPI";
import { _resetPluginIdentityForTests } from "../identity";
import type { PluginPermission } from "../types";
import { HOST_KEY, identityInvoke, tokenFor } from "./identityMock";

const mockInvoke = vi.mocked(invoke);

function callbacks(): PluginAPICallbacks {
	return {
		onPanelToggle: vi.fn(),
		onPanelShow: vi.fn(),
		onPanelHide: vi.fn(),
		onToast: vi.fn(),
		onStatusBarUpdate: vi.fn(),
	};
}

function plugin(id: string, permissions: PluginPermission[], activate: PluginModule["activate"] = vi.fn()): PluginModule {
	return {
		manifest: {
			id,
			name: id,
			version: "1.0.0",
			description: "",
			author: "test",
			activationEvents: [{ type: "onStartup" }],
			contributes: {},
			permissions,
		},
		activate,
	};
}

function callsTo(command: string) {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
}

/**
 * Everything reachable from `root` through own properties, Map/Set entries
 * and array items: what a script holding `root` could get at.
 */
function reachable(root: unknown): Set<unknown> {
	const seen = new Set<unknown>();
	const queue: unknown[] = [root];
	while (queue.length) {
		const value = queue.pop();
		if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
		seen.add(value);
		if (value instanceof Map) {
			for (const [k, v] of value) queue.push(k, v);
		} else if (value instanceof Set) {
			for (const v of value) queue.push(v);
		}
		for (const key of Reflect.ownKeys(value)) {
			try {
				queue.push((value as Record<PropertyKey, unknown>)[key]);
			} catch {
				// getters that throw are not reachable data
			}
		}
	}
	return seen;
}

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(identityInvoke);
	_resetPluginIdentityForTests();
});

describe("two plugins side by side", () => {
	it("each plugin's API calls the backend with its own token and never with a plugin id", async () => {
		const runtime = new PluginRuntime(callbacks());
		const apis: Record<string, HermesPluginAPI> = {};
		runtime.register(plugin("acme.github", ["network", "storage"], (api) => { apis.github = api; }));
		runtime.register(plugin("acme.rogue", ["storage"], (api) => { apis.rogue = api; }));
		await runtime.activateStartupPlugins();

		await apis.github.network.fetch("http://127.0.0.1:1/probe");
		await apis.github.storage.set("secret", "s3cret");
		await apis.rogue.storage.get("secret");

		expect(mockInvoke).toHaveBeenCalledWith("plugin_fetch_url", { url: "http://127.0.0.1:1/probe", headers: null, pluginToken: tokenFor("acme.github") });
		expect(mockInvoke).toHaveBeenCalledWith("set_plugin_setting", { key: "secret", value: "s3cret", pluginToken: tokenFor("acme.github") });
		expect(mockInvoke).toHaveBeenCalledWith("get_plugin_setting", { key: "secret", pluginToken: tokenFor("acme.rogue") });

		for (const [cmd, args] of mockInvoke.mock.calls) {
			if (["plugin_fetch_url", "set_plugin_setting", "get_plugin_setting"].includes(cmd)) {
				expect(args, `${cmd} must not name a plugin`).not.toHaveProperty("pluginId");
				expect(args, `${cmd} must not carry the host key`).not.toHaveProperty("hostKey");
			}
		}
	});

	it("the API surface itself does not reveal the token or the host key", async () => {
		const runtime = new PluginRuntime(callbacks());
		let captured: HermesPluginAPI | null = null;
		runtime.register(plugin("acme.rogue", ["storage"], (api) => { captured = api; }));
		await runtime.activate("acme.rogue");
		const strings = [...reachable(captured)].filter((v): v is string => typeof v === "string");
		const json = JSON.stringify(captured);
		expect(json).not.toContain(tokenFor("acme.rogue"));
		expect(json).not.toContain(HOST_KEY);
		expect(strings).not.toContain(tokenFor("acme.rogue"));
		expect(strings).not.toContain(HOST_KEY);
	});

	it("another plugin's API object is not reachable through the runtime", async () => {
		// The runtime is reachable from React props; a plugin walking the
		// component tree must not find a neighbour's API object there.
		const runtime = new PluginRuntime(callbacks());
		let githubApi: HermesPluginAPI | null = null;
		runtime.register(plugin("acme.github", ["network"], (api) => { githubApi = api; }));
		runtime.register(plugin("acme.rogue", []));
		await runtime.activateStartupPlugins();
		expect(githubApi).not.toBeNull();

		const found = reachable(runtime);
		expect(found.has(githubApi)).toBe(false);
		expect(found.has(githubApi!.network)).toBe(false);
		expect(found.has(githubApi!.shell)).toBe(false);
		expect(found.has(githubApi!.storage)).toBe(false);
	});
});

describe("runtime lifecycle", () => {
	it("mints the token before any plugin code runs, then records permissions with the host key", async () => {
		const runtime = new PluginRuntime(callbacks());
		const order: string[] = [];
		mockInvoke.mockImplementation(async (cmd, args) => {
			order.push(cmd);
			return identityInvoke(cmd, args as Record<string, unknown>);
		});
		runtime.register(plugin("acme.github", ["network"], () => { order.push("activate()"); }));
		await runtime.activate("acme.github");

		expect(order.indexOf("claim_plugin_host_key")).toBeLessThan(order.indexOf("issue_plugin_token"));
		expect(order.indexOf("issue_plugin_token")).toBeLessThan(order.indexOf("activate()"));
		expect(mockInvoke).toHaveBeenCalledWith("issue_plugin_token", { pluginId: "acme.github", hostKey: HOST_KEY });
		expect(mockInvoke).toHaveBeenCalledWith("save_plugin_metadata", {
			pluginId: "acme.github",
			version: "1.0.0",
			name: "acme.github",
			permissions: ["network"],
			hostKey: HOST_KEY,
		});
	});

	it("fails closed: no token, no activation", async () => {
		const runtime = new PluginRuntime(callbacks());
		mockInvoke.mockImplementation(async (cmd, args) => {
			if (cmd === "issue_plugin_token") throw new Error("invalid host key");
			return identityInvoke(cmd, args as Record<string, unknown>);
		});
		const activate = vi.fn();
		runtime.register(plugin("acme.github", ["network"], activate));
		await runtime.activate("acme.github");
		expect(activate).not.toHaveBeenCalled();
		expect(runtime.getAllPlugins()[0].status).toBe("error");
		expect(callsTo("save_plugin_metadata")).toHaveLength(0);
	});

	it("fails closed when the host key cannot be claimed", async () => {
		const runtime = new PluginRuntime(callbacks());
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "claim_plugin_host_key") throw new Error("already claimed");
			return undefined;
		});
		const activate = vi.fn();
		runtime.register(plugin("acme.github", ["network"], activate));
		await runtime.activate("acme.github");
		expect(activate).not.toHaveBeenCalled();
		expect(runtime.getAllPlugins()[0].status).toBe("error");
	});

	it("revokes the token on deactivate and after a failed activation", async () => {
		const runtime = new PluginRuntime(callbacks());
		runtime.register(plugin("acme.github", ["network"]));
		runtime.register(plugin("acme.broken", [], () => { throw new Error("boom"); }));
		await runtime.activateStartupPlugins();
		expect(callsTo("revoke_plugin_token").map(([, a]) => a)).toEqual([{ pluginId: "acme.broken", hostKey: HOST_KEY }]);

		await runtime.deactivate("acme.github");
		expect(mockInvoke).toHaveBeenLastCalledWith("revoke_plugin_token", { pluginId: "acme.github", hostKey: HOST_KEY });
	});

	it("a plugin that is unloaded loses its token too", async () => {
		const runtime = new PluginRuntime(callbacks());
		runtime.register(plugin("acme.github", ["network"]));
		await runtime.activate("acme.github");
		await runtime.unregister("acme.github");
		expect(callsTo("revoke_plugin_token")).toEqual([["revoke_plugin_token", { pluginId: "acme.github", hostKey: HOST_KEY }]]);
	});

	it("setting-change notifications still reach the plugin without the runtime holding its API", async () => {
		const runtime = new PluginRuntime(callbacks());
		const seen: unknown[] = [];
		const withSettings = plugin("acme.github", ["storage"], (api) => {
			api.settings.onDidChange("refreshInterval", (v) => seen.push(v));
		});
		withSettings.manifest.contributes.settings = {
			refreshInterval: { type: "number", default: 60, title: "Refresh" },
		};
		runtime.register(withSettings);
		await runtime.activate("acme.github");
		runtime.notifySettingChanged("acme.github", "refreshInterval", 30);
		expect(seen).toEqual([30]);
	});
});

describe("loader", () => {
	beforeEach(() => {
		delete (globalThis as { __hermesPlugins?: unknown }).__hermesPlugins;
	});

	it("claims the host key before it lists or reads any plugin", async () => {
		const order: string[] = [];
		mockInvoke.mockImplementation(async (cmd, args) => {
			order.push(cmd);
			if (cmd === "list_installed_plugins") return [];
			return identityInvoke(cmd, args as Record<string, unknown>);
		});
		await new PluginLoader(new PluginRuntime(callbacks())).loadAllPlugins();
		expect(order[0]).toBe("claim_plugin_host_key");
		expect(order).toContain("list_installed_plugins");
	});

	it("loads nothing when the host key is refused: no bundle is read or executed", async () => {
		mockInvoke.mockImplementation(async (cmd) => {
			if (cmd === "claim_plugin_host_key") throw new Error("already claimed");
			if (cmd === "list_installed_plugins") {
				return [{ id: "acme.rogue", dir_name: "acme.rogue", manifest_json: JSON.stringify(plugin("acme.rogue", []).manifest) }];
			}
			if (cmd === "read_plugin_bundle") return "window.__hermesPlugins = { 'acme.rogue': { activate() {} } };";
			return undefined;
		});
		const runtime = new PluginRuntime(callbacks());
		await new PluginLoader(runtime).loadAllPlugins();
		// Never even fetched, so nothing could have been executed.
		expect(callsTo("read_plugin_bundle")).toHaveLength(0);
		expect(callsTo("list_installed_plugins")).toHaveLength(0);
		expect(runtime.getPluginCount()).toBe(0);
		expect((globalThis as { __hermesPlugins?: unknown }).__hermesPlugins).toBeUndefined();
	});
});

describe("createPluginAPI", () => {
	it("binds every backend call to the token it was given", async () => {
		const api = createPluginAPI("acme.x", "tok-explicit", new Set(["storage", "network", "shell.exec"]), undefined, callbacks(), new Map(), new Map());
		await api.storage.delete("k");
		await api.network.postJson("http://127.0.0.1:1/", "{}", { "X-A": "1" });
		await api.shell.exec("echo", ["hi"]);
		expect(mockInvoke).toHaveBeenCalledWith("delete_plugin_setting", { key: "k", pluginToken: "tok-explicit" });
		expect(mockInvoke).toHaveBeenCalledWith("plugin_post_json", { url: "http://127.0.0.1:1/", body: "{}", headers: { "X-A": "1" }, pluginToken: "tok-explicit" });
		expect(mockInvoke).toHaveBeenCalledWith("plugin_exec_command", { command: "echo", args: ["hi"], pluginToken: "tok-explicit" });
	});
});
