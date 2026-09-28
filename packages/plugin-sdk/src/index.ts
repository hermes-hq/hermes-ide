export type {
	HermesPluginAPI,
	PluginPanelProps,
	Disposable,
	PluginManifest,
	PluginContributions,
	PluginCommandContribution,
	PluginPanelContribution,
	PluginStatusBarItem,
	PluginSessionActionContribution,
	PluginSettingsSchema,
	PluginSettingDefinition,
	PluginSettingString,
	PluginSettingNumber,
	PluginSettingBoolean,
	PluginSettingSelect,
	PluginPermission,
	HermesEvent,
	ActivationEvent,
	HermesPluginAPIv2,
	AgentStatus,
	AgentStatusKind,
	AgentSessionState,
	SessionEvent,
	InboxKind,
	InboxItem,
	FeatureTrack,
	FeatureTrackMeta,
	ReviewCheck,
	ReviewCheckInput,
	ReviewCheckResult,
	ReviewFile,
} from "./api";

import type { HermesPluginAPI, HermesPluginAPIv2 } from "./api";

/**
 * Helper to create a typed plugin module for the original plugin API (v1).
 * @deprecated v1 plugins stop loading in Hermes 2.2. Use definePluginV2 and
 * declare "apiVersion": 2 in hermes-plugin.json.
 */
export function definePlugin(plugin: {
	activate: (api: HermesPluginAPI) => void | Promise<void>;
	deactivate?: () => void | Promise<void>;
}): typeof plugin {
	return plugin;
}

/** Helper to create a typed plugin module for plugin API v2 ("apiVersion": 2). */
export function definePluginV2(plugin: {
	activate: (api: HermesPluginAPIv2) => void | Promise<void>;
	deactivate?: () => void | Promise<void>;
}): typeof plugin {
	return plugin;
}
