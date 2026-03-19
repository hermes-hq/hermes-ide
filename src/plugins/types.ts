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
	sessionActions?: PluginSessionActionContribution[];
	settings?: PluginSettingsSchema;
}

export interface PluginSessionActionContribution {
	id: string;        // unique action ID
	panelId: string;   // references a panel in contributes.panels
	name: string;      // tooltip label
	icon: string;      // inline SVG string
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
	side: "left" | "right" | "bottom";
	icon: string; // inline SVG string using currentColor
}

export interface FileHandlerProps {
	pluginId: string;
	filePath: string;
	content: string;
	sessionId: string;
	onBack: () => void;
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
	| "notifications"
	| "network"
	| "shell.exec";

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
	| "session.phase_changed"
	| "session.focus_changed"
	| "window.focused"
	| "window.blurred";

export interface Disposable {
	dispose(): void;
}

// ─── Plugin Session Info (rich session data for plugin API) ─────────

export interface SessionInfo {
	id: string;
	name: string;
	phase: string;
	detected_agent: string;
	working_directory: string;
	ai_provider?: string;
	branch?: string;
	created_at?: number;
}

// ─── Transcript Watching (JSONL agent transcripts) ──────────────────

export interface TranscriptEvent {
	type: "tool_start" | "tool_end" | "text" | "thinking" | "turn_end";
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	timestamp: number;
	session_id: string;
}

export interface AgentsAPI {
	watchTranscript(
		sessionId: string,
		callback: (event: TranscriptEvent) => void,
	): Promise<Disposable>;
}
