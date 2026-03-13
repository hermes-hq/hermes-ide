import type { PluginManifest, PluginCommandContribution, PluginPanelContribution, PluginStatusBarItem, HermesEvent } from "./types";
import { createPluginAPI, type HermesPluginAPI, type PluginPanelProps, type PluginAPICallbacks } from "./PluginAPI";

export type PluginActivateFn = (api: HermesPluginAPI) => void | Promise<void>;
export type PluginDeactivateFn = () => void | Promise<void>;

export interface PluginModule {
	manifest: PluginManifest;
	activate: PluginActivateFn;
	deactivate?: PluginDeactivateFn;
}

export type PluginStatus = "registered" | "activating" | "active" | "error" | "inactive";

interface PluginEntry {
	module: PluginModule;
	status: PluginStatus;
	api: HermesPluginAPI | null;
	error?: Error;
}

export interface RuntimeStatusBarItem extends PluginStatusBarItem {
	pluginId: string;
	visible: boolean;
}

export class PluginRuntime {
	private plugins = new Map<string, PluginEntry>();
	private commandHandlers = new Map<string, () => void | Promise<void>>();
	private panelComponents = new Map<string, React.ComponentType<PluginPanelProps>>();
	private statusBarOverrides = new Map<string, { text?: string; tooltip?: string; visible?: boolean }>();
	private changeListeners = new Set<() => void>();
	private eventListeners = new Map<HermesEvent, Set<(...args: unknown[]) => void>>();
	private callbacks: PluginAPICallbacks;

	constructor(callbacks: PluginAPICallbacks) {
		this.callbacks = callbacks;
	}

	register(module: PluginModule): void {
		const { id } = module.manifest;
		if (this.plugins.has(id)) {
			console.warn(`[PluginRuntime] Plugin "${id}" already registered`);
			return;
		}
		this.plugins.set(id, { module, status: "registered", api: null });
		this.notify();
	}

	async activate(pluginId: string): Promise<void> {
		const entry = this.plugins.get(pluginId);
		if (!entry || entry.status === "active" || entry.status === "activating") return;

		entry.status = "activating";
		this.notify();

		// Snapshot registered commands/panels before activation so we can
		// roll back partial registrations if activate() throws.
		const cmdsBefore = new Set(this.commandHandlers.keys());
		const panelsBefore = new Set(this.panelComponents.keys());

		try {
			const permissions = new Set<string>(entry.module.manifest.permissions ?? []);
			const settingsSchema = entry.module.manifest.contributes.settings;
			const fullCallbacks: PluginAPICallbacks = {
				...this.callbacks,
				onSettingChanged: (pid: string, key: string, value: string | number | boolean) => {
					this.notifySettingChanged(pid, key, value);
				},
				onEventSubscribe: (event: HermesEvent, callback: (...args: unknown[]) => void) => {
					return this.subscribeEvent(event, callback);
				},
			};
			const api = createPluginAPI(
				pluginId,
				permissions,
				settingsSchema,
				fullCallbacks,
				this.commandHandlers,
				this.panelComponents,
			);
			entry.api = api;
			await entry.module.activate(api);
			entry.status = "active";
		} catch (err) {
			entry.status = "error";
			entry.error = err instanceof Error ? err : new Error(String(err));
			console.error(`[PluginRuntime] Failed to activate "${pluginId}":`, err);

			// Roll back any commands/panels registered before the error
			for (const cmd of this.commandHandlers.keys()) {
				if (!cmdsBefore.has(cmd)) this.commandHandlers.delete(cmd);
			}
			for (const panel of this.panelComponents.keys()) {
				if (!panelsBefore.has(panel)) this.panelComponents.delete(panel);
			}

			// Dispose subscriptions added during partial activation
			if (entry.api) {
				for (const sub of entry.api.subscriptions) {
					try { sub.dispose(); } catch {}
				}
				entry.api = null;
			}
		}
		this.notify();
	}

	async deactivate(pluginId: string): Promise<void> {
		const entry = this.plugins.get(pluginId);
		if (!entry || entry.status !== "active") return;

		try {
			await entry.module.deactivate?.();
		} catch (err) {
			console.error(`[PluginRuntime] Error deactivating "${pluginId}":`, err);
		}

		// Dispose all subscriptions
		if (entry.api) {
			for (const sub of entry.api.subscriptions) {
				try { sub.dispose(); } catch {}
			}
		}

		entry.api = null;
		entry.status = "inactive";
		this.notify();
	}

	async unregister(pluginId: string): Promise<void> {
		const entry = this.plugins.get(pluginId);
		if (!entry) return;

		if (entry.status === "active") {
			await this.deactivate(pluginId);
		}

		// Clean up any registered commands and panels from this plugin
		for (const cmd of entry.module.manifest.contributes.commands ?? []) {
			this.commandHandlers.delete(cmd.command);
		}
		for (const panel of entry.module.manifest.contributes.panels ?? []) {
			this.panelComponents.delete(panel.id);
		}
		for (const item of entry.module.manifest.contributes.statusBarItems ?? []) {
			this.statusBarOverrides.delete(item.id);
		}

		this.plugins.delete(pluginId);
		this.notify();
	}

	async activateStartupPlugins(): Promise<void> {
		for (const [id, entry] of this.plugins) {
			const hasStartup = entry.module.manifest.activationEvents.some((e: { type: string }) => e.type === "onStartup");
			if (hasStartup && entry.status === "registered") {
				await this.activate(id);
			}
		}
	}

	// ─── Settings & Events ────────────────────────────────────

	notifySettingChanged(pluginId: string, key: string, value: string | number | boolean): void {
		const entry = this.plugins.get(pluginId);
		if (!entry?.api) return;
		entry.api._notifySettingChanged(key, value);
	}

	private subscribeEvent(event: HermesEvent, callback: (...args: unknown[]) => void): { dispose(): void } {
		let listeners = this.eventListeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.eventListeners.set(event, listeners);
		}
		listeners.add(callback);
		return {
			dispose: () => {
				listeners!.delete(callback);
				if (listeners!.size === 0) {
					this.eventListeners.delete(event);
				}
			},
		};
	}

	emitEvent(event: HermesEvent, ...args: unknown[]): void {
		const listeners = this.eventListeners.get(event);
		if (!listeners) return;
		for (const cb of listeners) {
			try { cb(...args); } catch { /* swallow */ }
		}
	}

	// ─── Query Methods ─────────────────────────────────────────

	getAllCommands(): (PluginCommandContribution & { pluginId: string; pluginName: string })[] {
		const result: (PluginCommandContribution & { pluginId: string; pluginName: string })[] = [];
		for (const [id, entry] of this.plugins) {
			if (entry.status !== "active") continue;
			const pluginName = entry.module.manifest.name;
			for (const cmd of entry.module.manifest.contributes.commands ?? []) {
				result.push({ ...cmd, pluginId: id, pluginName });
			}
		}
		return result;
	}

	getPluginsWithSettings(): { pluginId: string; pluginName: string }[] {
		const result: { pluginId: string; pluginName: string }[] = [];
		for (const [id, entry] of this.plugins) {
			if (entry.status !== "active") continue;
			if (entry.module.manifest.contributes.settings && Object.keys(entry.module.manifest.contributes.settings).length > 0) {
				result.push({ pluginId: id, pluginName: entry.module.manifest.name });
			}
		}
		return result;
	}

	getAllPanels(): (PluginPanelContribution & { pluginId: string })[] {
		const result: (PluginPanelContribution & { pluginId: string })[] = [];
		for (const [id, entry] of this.plugins) {
			if (entry.status !== "active") continue;
			for (const panel of entry.module.manifest.contributes.panels ?? []) {
				result.push({ ...panel, pluginId: id });
			}
		}
		return result;
	}

	getPanelComponent(panelId: string): React.ComponentType<PluginPanelProps> | undefined {
		return this.panelComponents.get(panelId);
	}

	getAllStatusBarItems(): RuntimeStatusBarItem[] {
		const result: RuntimeStatusBarItem[] = [];
		for (const [id, entry] of this.plugins) {
			if (entry.status !== "active") continue;
			for (const item of entry.module.manifest.contributes.statusBarItems ?? []) {
				const override = this.statusBarOverrides.get(item.id);
				result.push({
					...item,
					pluginId: id,
					text: override?.text ?? item.text,
					tooltip: override?.tooltip ?? item.tooltip,
					visible: override?.visible ?? true,
				});
			}
		}
		return result;
	}

	updateStatusBarItem(itemId: string, update: { text?: string; tooltip?: string; visible?: boolean }): void {
		const existing = this.statusBarOverrides.get(itemId) ?? {};
		this.statusBarOverrides.set(itemId, { ...existing, ...update });
		this.notify();
	}

	async executeCommand(commandId: string): Promise<void> {
		const handler = this.commandHandlers.get(commandId);
		if (!handler) {
			console.warn(`[PluginRuntime] No handler for command "${commandId}"`);
			return;
		}
		await handler();
	}

	getPluginCount(): number {
		return this.plugins.size;
	}

	subscribe(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.changeListeners) {
			try { listener(); } catch {}
		}
	}
}
