import type { Disposable, PluginSettingsSchema, HermesEvent, SessionInfo, TranscriptEvent, AgentsAPI, FileHandlerProps } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

// Props passed to plugin panel components via React context
export interface PluginPanelProps {
	pluginId: string;
	panelId: string;
}

// The API surface available to every plugin
export interface HermesPluginAPI {
	ui: {
		registerPanel(panelId: string, component: React.ComponentType<PluginPanelProps>): Disposable;
		showPanel(panelId: string): void;
		hidePanel(panelId: string): void;
		togglePanel(panelId: string): void;
		showToast(message: string, options?: { type?: "info" | "success" | "warning" | "error"; duration?: number }): void;
		updateStatusBarItem(itemId: string, update: { text?: string; tooltip?: string; visible?: boolean }): void;
		updateSessionActionBadge(actionId: string, badge: { text?: string; count?: number }): void;
		registerFileHandler(extensions: string[], component: React.ComponentType<FileHandlerProps>): Disposable;
	};
	commands: {
		register(commandId: string, handler: () => void | Promise<void>): Disposable;
		execute(commandId: string): Promise<void>;
	};
	clipboard: {
		readText(): Promise<string>;
		writeText(text: string): Promise<void>;
	};
	storage: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	settings: {
		get<T = string | number | boolean>(key: string): Promise<T>;
		update(key: string, value: string | number | boolean): Promise<void>;
		onDidChange(key: string, callback: (newValue: string | number | boolean) => void): Disposable;
		getAll(): Promise<Record<string, string | number | boolean>>;
	};
	events: {
		on(event: HermesEvent, callback: (...args: unknown[]) => void): Disposable;
	};
	notifications: {
		send(options: { title: string; body?: string }): Promise<void>;
	};
	network: {
		fetch(url: string): Promise<string>;
	};
	shell: {
		openExternal(url: string): Promise<void>;
		exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	};
	sessions: {
		getActive(): Promise<SessionInfo | null>;
		list(): Promise<SessionInfo[]>;
		focus(sessionId: string): Promise<void>;
	};
	agents: AgentsAPI;
	subscriptions: Disposable[];
	/** @internal Used by PluginRuntime to forward UI settings changes to plugin listeners. */
	_notifySettingChanged(key: string, value: string | number | boolean): void;
}

export class PermissionDeniedError extends Error {
	constructor(pluginId: string, permission: string) {
		super(`Plugin "${pluginId}" requires permission "${permission}" which was not granted.`);
		this.name = "PermissionDeniedError";
	}
}

export type PanelToggleCallback = (panelId: string) => void;
export type ToastCallback = (message: string, type: string, duration?: number) => void;
export type StatusBarUpdateCallback = (itemId: string, update: { text?: string; tooltip?: string; visible?: boolean }) => void;

export interface PluginAPICallbacks {
	onPanelToggle: PanelToggleCallback;
	onPanelShow: PanelToggleCallback;
	onPanelHide: PanelToggleCallback;
	onToast: ToastCallback;
	onStatusBarUpdate: StatusBarUpdateCallback;
	onSessionActionBadgeUpdate?: (actionId: string, badge: { text?: string; count?: number }) => void;
	onSettingChanged?: (pluginId: string, key: string, value: string | number | boolean) => void;
	onEventSubscribe?: (event: HermesEvent, callback: (...args: unknown[]) => void) => Disposable;
	onNotification?: (options: { title: string; body?: string }) => Promise<void>;
	onSessionsGetActive?: () => Promise<SessionInfo | null>;
	onSessionsList?: () => Promise<SessionInfo[]>;
	onSessionFocus?: (sessionId: string) => void;
	onFileHandlerRegistered?: () => void;
}

export function createPluginAPI(
	pluginId: string,
	permissions: Set<string>,
	settingsSchema: PluginSettingsSchema | undefined,
	callbacks: PluginAPICallbacks,
	commandHandlers: Map<string, () => void | Promise<void>>,
	panelComponents: Map<string, React.ComponentType<PluginPanelProps>>,
	fileHandlers?: Map<string, { pluginId: string; component: React.ComponentType<FileHandlerProps> }>,
): HermesPluginAPI {
	const subscriptions: Disposable[] = [];
	const schema = settingsSchema ?? {};
	const settingsChangeListeners = new Map<string, Set<(value: string | number | boolean) => void>>();

	return {
		_notifySettingChanged(key: string, value: string | number | boolean) {
			const listeners = settingsChangeListeners.get(key);
			if (listeners) {
				for (const cb of listeners) {
					try { cb(value); } catch { /* swallow */ }
				}
			}
		},
		ui: {
			registerPanel(panelId: string, component: React.ComponentType<PluginPanelProps>) {
				if (panelComponents.has(panelId)) {
					console.warn(`[Plugin:${pluginId}] Panel ID "${panelId}" is already registered — overwriting`);
				}
				panelComponents.set(panelId, component);
				return {
					dispose() {
						panelComponents.delete(panelId);
					},
				};
			},
			showPanel(panelId: string) {
				callbacks.onPanelShow(panelId);
			},
			hidePanel(panelId: string) {
				callbacks.onPanelHide(panelId);
			},
			togglePanel(panelId: string) {
				callbacks.onPanelToggle(panelId);
			},
			showToast(message: string, options?: { type?: "info" | "success" | "warning" | "error"; duration?: number }) {
				callbacks.onToast(message, options?.type ?? "info", options?.duration);
			},
			updateStatusBarItem(itemId: string, update: { text?: string; tooltip?: string; visible?: boolean }) {
				callbacks.onStatusBarUpdate(itemId, update);
			},
			updateSessionActionBadge(actionId: string, badge: { text?: string; count?: number }) {
				callbacks.onSessionActionBadgeUpdate?.(actionId, badge);
			},
			registerFileHandler(extensions: string[], component: React.ComponentType<FileHandlerProps>): Disposable {
				if (!fileHandlers) return { dispose() {} };
				const normalized = extensions.map(e => e.toLowerCase().replace(/^\./, ""));
				for (const ext of normalized) {
					fileHandlers.set(ext, { pluginId, component });
				}
				callbacks.onFileHandlerRegistered?.();
				return {
					dispose() {
						for (const ext of normalized) {
							fileHandlers?.delete(ext);
						}
					},
				};
			},
		},
		commands: {
			register(commandId: string, handler: () => void | Promise<void>) {
				if (commandHandlers.has(commandId)) {
					console.warn(`[Plugin:${pluginId}] Command ID "${commandId}" is already registered — overwriting`);
				}
				commandHandlers.set(commandId, handler);
				return {
					dispose() {
						commandHandlers.delete(commandId);
					},
				};
			},
			async execute(commandId: string) {
				const handler = commandHandlers.get(commandId);
				if (handler) await handler();
			},
		},
		clipboard: {
			readText() {
				if (!permissions.has("clipboard.read")) {
					throw new PermissionDeniedError(pluginId, "clipboard.read");
				}
				return navigator.clipboard.readText();
			},
			writeText(text: string) {
				if (!permissions.has("clipboard.write")) {
					throw new PermissionDeniedError(pluginId, "clipboard.write");
				}
				return navigator.clipboard.writeText(text);
			},
		},
		storage: {
			async get(key: string) {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				return invoke<string | null>("get_plugin_setting", { pluginId, key });
			},
			async set(key: string, value: string) {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				if (key.startsWith("__setting:")) {
					throw new Error(`Plugin "${pluginId}": storage key "${key}" is reserved. Use api.settings.update() instead.`);
				}
				await invoke("set_plugin_setting", { pluginId, key, value });
			},
			async delete(key: string) {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				await invoke("delete_plugin_setting", { pluginId, key });
			},
		},
		settings: {
			async get<T = string | number | boolean>(key: string): Promise<T> {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				const def = schema[key];
				if (!def) return undefined as unknown as T;

				const stored = await invoke<string | null>("get_plugin_setting", {
					pluginId,
					key: `__setting:${key}`,
				});

				if (stored === null || stored === undefined) {
					return def.default as unknown as T;
				}

				if (def.type === "number") return parseFloat(stored) as unknown as T;
				if (def.type === "boolean") return (stored === "true") as unknown as T;
				return stored as unknown as T;
			},
			async update(key: string, value: string | number | boolean) {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				const def = schema[key];
				if (!def) {
					throw new Error(`Plugin "${pluginId}": unknown setting key "${key}".`);
				}

				const valueType = typeof value;
				if (def.type === "number") {
					if (valueType !== "number") {
						throw new Error(`Plugin "${pluginId}": setting "${key}" expects a number, got ${valueType}.`);
					}
					if (def.min !== undefined && (value as number) < def.min) {
						throw new Error(`Plugin "${pluginId}": setting "${key}" value ${value} is below minimum ${def.min}.`);
					}
					if (def.max !== undefined && (value as number) > def.max) {
						throw new Error(`Plugin "${pluginId}": setting "${key}" value ${value} is above maximum ${def.max}.`);
					}
				} else if (def.type === "boolean") {
					if (valueType !== "boolean") {
						throw new Error(`Plugin "${pluginId}": setting "${key}" expects a boolean, got ${valueType}.`);
					}
				} else if (def.type === "select") {
					if (!def.options.some((o) => o.value === value)) {
						throw new Error(`Plugin "${pluginId}": setting "${key}" value "${value}" is not a valid option.`);
					}
				} else if (def.type === "string") {
					if (valueType !== "string") {
						throw new Error(`Plugin "${pluginId}": setting "${key}" expects a string, got ${valueType}.`);
					}
				}

				await invoke("set_plugin_setting", {
					pluginId,
					key: `__setting:${key}`,
					value: String(value),
				});

				callbacks.onSettingChanged?.(pluginId, key, value);

				// Notify local listeners
				const listeners = settingsChangeListeners.get(key);
				if (listeners) {
					for (const cb of listeners) {
						try { cb(value); } catch { /* swallow */ }
					}
				}
			},
			onDidChange(key: string, callback: (newValue: string | number | boolean) => void): Disposable {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				let listeners = settingsChangeListeners.get(key);
				if (!listeners) {
					listeners = new Set();
					settingsChangeListeners.set(key, listeners);
				}
				listeners.add(callback);
				return {
					dispose() {
						listeners!.delete(callback);
						if (listeners!.size === 0) {
							settingsChangeListeners.delete(key);
						}
					},
				};
			},
			async getAll(): Promise<Record<string, string | number | boolean>> {
				if (!permissions.has("storage")) {
					throw new PermissionDeniedError(pluginId, "storage");
				}
				const result: Record<string, string | number | boolean> = {};
				for (const [key, def] of Object.entries(schema)) {
					const stored = await invoke<string | null>("get_plugin_setting", {
						pluginId,
						key: `__setting:${key}`,
					});
					if (stored === null || stored === undefined) {
						result[key] = def.default;
					} else if (def.type === "number") {
						result[key] = parseFloat(stored);
					} else if (def.type === "boolean") {
						result[key] = stored === "true";
					} else {
						result[key] = stored;
					}
				}
				return result;
			},
		},
		events: {
			on(event: HermesEvent, callback: (...args: unknown[]) => void): Disposable {
				if (callbacks.onEventSubscribe) {
					return callbacks.onEventSubscribe(event, callback);
				}
				return { dispose() {} };
			},
		},
		notifications: {
			async send(options: { title: string; body?: string }) {
				if (!permissions.has("notifications")) {
					throw new PermissionDeniedError(pluginId, "notifications");
				}
				if (callbacks.onNotification) {
					await callbacks.onNotification(options);
				}
			},
		},
		network: {
			fetch(url: string): Promise<string> {
				if (!permissions.has("network")) {
					throw new PermissionDeniedError(pluginId, "network");
				}
				return invoke("plugin_fetch_url", { url, pluginId });
			},
		},
		shell: {
			async openExternal(url: string): Promise<void> {
				if (!permissions.has("network")) {
					throw new PermissionDeniedError(pluginId, "network");
				}
				await shellOpen(url);
			},
			async exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
				if (!permissions.has("shell.exec")) {
					throw new PermissionDeniedError(pluginId, "shell.exec");
				}
				return invoke("plugin_exec_command", { command, args: args ?? [], pluginId });
			},
		},
		sessions: {
			async getActive() {
				if (!permissions.has("sessions.read")) {
					throw new PermissionDeniedError(pluginId, "sessions.read");
				}
				if (callbacks.onSessionsGetActive) {
					return callbacks.onSessionsGetActive();
				}
				return null;
			},
			async list() {
				if (!permissions.has("sessions.read")) {
					throw new PermissionDeniedError(pluginId, "sessions.read");
				}
				if (callbacks.onSessionsList) {
					return callbacks.onSessionsList();
				}
				return [];
			},
			async focus(sessionId: string) {
				if (!permissions.has("sessions.read")) {
					throw new PermissionDeniedError(pluginId, "sessions.read");
				}
				callbacks.onSessionFocus?.(sessionId);
			},
		},
		agents: {
			async watchTranscript(
				sessionId: string,
				callback: (event: TranscriptEvent) => void,
			): Promise<Disposable> {
				if (!permissions.has("sessions.read")) {
					throw new PermissionDeniedError(pluginId, "sessions.read");
				}
				try {
					const watcherId: string = await invoke("start_transcript_watcher", { sessionId });
					const eventName = `transcript-event:${watcherId}`;
					const unlisten = await listen<TranscriptEvent>(eventName, (event) => {
						try { callback(event.payload); } catch { /* swallow plugin errors */ }
					});
					const dispose = () => {
						unlisten();
						invoke("stop_transcript_watcher", { watcherId }).catch(() => {});
					};
					subscriptions.push({ dispose });
					return { dispose };
				} catch (err) {
					console.warn(`[Plugin:${pluginId}] Failed to watch transcript for session ${sessionId}:`, err);
					return { dispose() {} };
				}
			},
		},
		subscriptions,
	};
}
