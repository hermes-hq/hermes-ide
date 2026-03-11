import { invoke } from "@tauri-apps/api/core";
import type { PluginManifest } from "./types";
import type { PluginRuntime, PluginModule } from "./PluginRuntime";
import type { PluginActivateFn, PluginDeactivateFn } from "./PluginRuntime";

interface InstalledPluginInfo {
	id: string;
	dir_name: string;
	manifest_json: string;
}

declare global {
	interface Window {
		__hermesPlugins?: Record<string, {
			activate: PluginActivateFn;
			deactivate?: PluginDeactivateFn;
		}>;
	}
}

/**
 * Loads external plugins from the user's plugins directory on disk.
 *
 * Plugin format:
 *   plugins/<plugin-id>/
 *     hermes-plugin.json   – manifest
 *     dist/index.js         – IIFE bundle (registers on window.__hermesPlugins)
 *
 * The IIFE bundle is loaded via a blob URL to satisfy CSP (script-src 'self' blob:).
 * React is provided as window.React so plugins can use JSX without bundling React.
 */
export class PluginLoader {
	private runtime: PluginRuntime;
	private loadedPlugins = new Set<string>();
	private disabledIds = new Set<string>();

	constructor(runtime: PluginRuntime) {
		this.runtime = runtime;
	}

	/**
	 * Scan the plugins directory and load all installed plugins.
	 * Skips plugins that are disabled in the database.
	 */
	async loadAllPlugins(): Promise<void> {
		// Fetch disabled plugin IDs from DB
		try {
			const disabled = await invoke<string[]>("get_disabled_plugin_ids");
			this.disabledIds = new Set(disabled);
		} catch {
			// DB not available — load all
		}

		let plugins: InstalledPluginInfo[];
		try {
			plugins = await invoke<InstalledPluginInfo[]>("list_installed_plugins");
		} catch (err) {
			console.warn("[PluginLoader] Failed to list installed plugins:", err);
			return;
		}

		for (const plugin of plugins) {
			if (this.disabledIds.has(plugin.id)) {
				console.log(`[PluginLoader] Skipping disabled plugin "${plugin.id}"`);
				continue;
			}
			try {
				await this.loadPlugin(plugin);
			} catch (err) {
				console.error(`[PluginLoader] Failed to load plugin "${plugin.id}":`, err);
			}
		}
	}

	/**
	 * Load a single plugin from its directory.
	 * If the plugin is already loaded (e.g. during hot-reload), the old
	 * version is fully cleaned up before the new one is loaded.
	 */
	private async loadPlugin(info: InstalledPluginInfo): Promise<void> {
		// Clean up any previously loaded version of this plugin.
		// Handles hot-reload: removes old script tag, global reference,
		// and unregisters from the runtime so the new version can register.
		// All operations are no-ops if the plugin isn't loaded yet.
		await this.cleanupPlugin(info.id);

		// Parse manifest
		let manifest: PluginManifest;
		try {
			manifest = JSON.parse(info.manifest_json);
		} catch {
			throw new Error(`Invalid manifest JSON for plugin "${info.id}"`);
		}

		// Read the JS bundle from disk via Tauri IPC
		let bundleCode: string;
		try {
			bundleCode = await invoke<string>("read_plugin_bundle", {
				pluginDir: info.dir_name,
			});
		} catch (err) {
			throw new Error(`Failed to read bundle for "${info.id}": ${err}`);
		}

		// Load the bundle via blob URL
		await this.executeBundle(bundleCode, info.id);

		// Retrieve the registered plugin exports
		const pluginExports = window.__hermesPlugins?.[info.id];
		if (!pluginExports) {
			throw new Error(
				`Plugin "${info.id}" bundle did not register on window.__hermesPlugins. ` +
				`Make sure the plugin's IIFE footer sets window.__hermesPlugins["${info.id}"].`
			);
		}

		// Create the PluginModule and register with the runtime
		const module: PluginModule = {
			manifest,
			activate: pluginExports.activate,
			deactivate: pluginExports.deactivate,
		};

		this.runtime.register(module);
		this.loadedPlugins.add(info.id);

		console.log(`[PluginLoader] Loaded plugin "${info.id}" v${manifest.version}`);
	}

	/**
	 * Execute a JavaScript bundle string by creating a blob URL and loading it as a script.
	 */
	private executeBundle(code: string, pluginId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const blob = new Blob([code], { type: "application/javascript" });
			const url = URL.createObjectURL(blob);

			const script = document.createElement("script");
			script.src = url;
			script.dataset.pluginId = pluginId;

			script.onload = () => {
				URL.revokeObjectURL(url);
				resolve();
			};

			script.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error(`Failed to execute bundle for plugin "${pluginId}"`));
			};

			document.head.appendChild(script);
		});
	}

	/**
	 * Unload a plugin: deactivate, unregister, and remove its script tag.
	 */
	async cleanupPlugin(pluginId: string): Promise<void> {
		await this.runtime.unregister(pluginId);
		this.loadedPlugins.delete(pluginId);

		// Remove the injected script tag
		const script = document.querySelector(`script[data-plugin-id="${CSS.escape(pluginId)}"]`);
		if (script) {
			script.remove();
		}

		// Clean up global registration
		if (window.__hermesPlugins?.[pluginId]) {
			delete window.__hermesPlugins[pluginId];
		}
	}

	/**
	 * Reload a single plugin: cleanup, re-read from disk, and re-activate.
	 */
	async reloadPlugin(info: InstalledPluginInfo): Promise<void> {
		if (this.loadedPlugins.has(info.id)) {
			await this.cleanupPlugin(info.id);
		}
		await this.loadPlugin(info);
		await this.runtime.activate(info.id);
	}

	/**
	 * Get the set of loaded plugin IDs.
	 */
	getLoadedPlugins(): Set<string> {
		return new Set(this.loadedPlugins);
	}
}
