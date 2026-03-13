// Plugin manifest types — Phase 1 uses TypeScript objects; Phase 2+ will use plugin.json files

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	activationEvents: ActivationEvent[];
	contributes: PluginContributions;
	permissions?: PluginPermission[];
}

export type ActivationEvent =
	| { type: "onStartup" }
	| { type: "onCommand"; command: string }
	| { type: "onView"; viewId: string };

export interface PluginContributions {
	commands?: PluginCommandContribution[];
	panels?: PluginPanelContribution[];
	statusBarItems?: PluginStatusBarItem[];
	settings?: PluginSettingsSchema;
}

export interface PluginCommandContribution {
	command: string;
	title: string;
	category?: string;
	keybinding?: string;
}

export interface PluginPanelContribution {
	id: string;
	name: string;
	side: "left" | "right";
	icon: string; // inline SVG string using currentColor
}

export interface PluginStatusBarItem {
	id: string;
	text: string;
	tooltip?: string;
	alignment: "left" | "right";
	priority?: number;
	command?: string;
}

export type PluginPermission =
	| "clipboard.read"
	| "clipboard.write"
	| "storage"
	| "terminal.read"
	| "terminal.write"
	| "sessions.read"
	| "notifications";

// ─── Plugin Settings Schema ──────────────────────────────

export interface PluginSettingsSchema {
	[key: string]: PluginSettingDefinition;
}

export type PluginSettingDefinition =
	| PluginSettingString
	| PluginSettingNumber
	| PluginSettingBoolean
	| PluginSettingSelect;

interface PluginSettingBase {
	title: string;
	description?: string;
	order?: number;
}

export interface PluginSettingString extends PluginSettingBase {
	type: "string";
	default: string;
	placeholder?: string;
	maxLength?: number;
}

export interface PluginSettingNumber extends PluginSettingBase {
	type: "number";
	default: number;
	min?: number;
	max?: number;
	step?: number;
}

export interface PluginSettingBoolean extends PluginSettingBase {
	type: "boolean";
	default: boolean;
}

export interface PluginSettingSelect extends PluginSettingBase {
	type: "select";
	default: string;
	options: { value: string; label: string }[];
}

// ─── Registry Types ──────────────────────────────────────

export interface ChangelogEntry {
	version: string;
	date: string;
	changes: string[];
}

export interface RegistryPlugin {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	icon?: string;
	category?: string;
	downloadUrl: string;
	minAppVersion?: string;
	permissions?: string[];
	changelog?: ChangelogEntry[];
}

export type HermesEvent =
	| "theme.changed"
	| "session.created"
	| "session.closed"
	| "window.focused"
	| "window.blurred";

export interface Disposable {
	dispose(): void;
}
