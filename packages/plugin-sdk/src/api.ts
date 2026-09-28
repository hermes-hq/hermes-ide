// ─── Core Types ──────────────────────────────────────────

export interface Disposable {
	dispose(): void;
}

export interface PluginPanelProps {
	pluginId: string;
	panelId: string;
}

// ─── Manifest Types ──────────────────────────────────────

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	/**
	 * The plugin API the plugin is built for. Leave it out (or 1) for the
	 * original API, which is deprecated and stops loading in Hermes 2.2; set 2
	 * for HermesPluginAPIv2.
	 */
	apiVersion?: 1 | 2;
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
	id: string;
	panelId: string;
	name: string;
	icon: string;
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
	icon: string;
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
	| "shell.exec"
	// Plugin API v2
	| "inbox.raise"
	| "features.read"
	| "review.checks";

// ─── Settings Schema ─────────────────────────────────────

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

// ─── Events ──────────────────────────────────────────────

export type HermesEvent =
	| "theme.changed"
	| "session.created"
	| "session.closed"
	| "window.focused"
	| "window.blurred";

// ─── Plugin API ──────────────────────────────────────────

export interface HermesPluginAPI {
	ui: {
		registerPanel(panelId: string, component: React.ComponentType<PluginPanelProps>): Disposable;
		showPanel(panelId: string): void;
		hidePanel(panelId: string): void;
		togglePanel(panelId: string): void;
		showToast(message: string, options?: { type?: "info" | "success" | "warning" | "error"; duration?: number }): void;
		updateStatusBarItem(itemId: string, update: { text?: string; tooltip?: string; visible?: boolean }): void;
		updateSessionActionBadge(actionId: string, badge: { text?: string; count?: number }): void;
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
		on(event: HermesEvent, callback: (...args: any[]) => void): Disposable;
	};
	notifications: {
		send(options: { title: string; body?: string }): Promise<void>;
	};
	network: {
		/** Fetch a URL and return the response body as text. Requires "network" permission. */
		fetch(url: string): Promise<string>;
	};
	shell: {
		/** Open a URL in the user's default browser. Requires "network" permission. */
		openExternal(url: string): Promise<void>;
		/** Execute a shell command and return its output. Requires "shell.exec" permission. */
		exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	};
	sessions: {
		getActive(): Promise<{ id: string; name: string } | null>;
		list(): Promise<{ id: string; name: string }[]>;
		focus(sessionId: string): Promise<void>;
	};
	agents: {
		/**
		 * Watch a session's AI agent transcript in real time. Requires "sessions.read" permission.
		 * @deprecated Claude-shaped. In plugin API v2 use `agents.onEvent`, which reports every agent the same way.
		 */
		watchTranscript(
			sessionId: string,
			callback: (event: { type: string; tool_name?: string; timestamp: number; session_id: string }) => void,
		): Promise<Disposable>;
	};
	subscriptions: Disposable[];
	/** 1 for this (original) API. */
	apiVersion: 1 | 2;
}

// ─── Plugin API v2 ───────────────────────────────────────
//
// Declare `"apiVersion": 2` in hermes-plugin.json to get these. The shapes
// mirror Hermes' 2.0 contracts (docs/adr/004-2.0-contracts.md in the Hermes
// repository): one status vocabulary and one event stream for every agent.

export type AgentStatusKind =
	| "needs_approval"
	| "needs_answer"
	| "gate"
	| "check_failed"
	| "error"
	| "limited"
	| "plan_ready"
	| "done_unread"
	| "working"
	| "startup_prompt"
	| "starting"
	| "idle"
	| "exited";

export interface AgentStatus {
	readonly kind: AgentStatusKind;
	/** exact: the agent said so; signal: a notification; guessed: a heuristic. */
	readonly confidence: "exact" | "signal" | "guessed";
	readonly detail: string;
}

interface SessionEventBase {
	/** Epoch milliseconds. */
	readonly at: number;
	readonly source?: string;
}

/** Newer Hermes versions may add event types: ignore the ones you do not know. */
export type SessionEvent =
	| (SessionEventBase & { readonly type: "status"; readonly status: AgentStatus })
	| (SessionEventBase & { readonly type: "turn_start" | "turn_end" | "turn_interrupted"; readonly n: number })
	| (SessionEventBase & { readonly type: "turn_failed"; readonly n: number; readonly detail: string })
	| (SessionEventBase & { readonly type: "attention"; readonly detail: string })
	| (SessionEventBase & {
			readonly type: "identity";
			readonly vendorSessionId: string | null;
			readonly model: string | null;
			readonly permissionMode: string | null;
	  })
	| (SessionEventBase & { readonly type: "exit"; readonly code: number | null; readonly signal: string | null });

export interface AgentSessionState {
	readonly sessionId: string;
	readonly status: AgentStatus;
	readonly identity: { readonly vendorSessionId: string | null; readonly model: string | null; readonly permissionMode: string | null };
	readonly turn: { readonly current: number | null; readonly completed: number };
	readonly attention: string | null;
	readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
	/** 0 when nothing has been reported about the session yet. */
	readonly version: number;
}

export type InboxKind = "blocked" | "ready" | "gate" | "error" | "limit";

export interface InboxItem {
	readonly id: string;
	readonly kind: InboxKind;
	readonly sessionId: string | null;
	readonly detail: string;
	readonly createdAt: number;
	/** Always "plugin:<your id>" for items you raise. */
	readonly source: string;
}

export interface FeatureTrackMeta {
	readonly slug: string;
	readonly track: "Quick" | "Light" | "Full";
	readonly phase: "questions" | "research" | "design" | "structure" | "plan" | "implement" | "done";
	readonly gate: "none" | "waiting" | "approved";
	readonly doneWhen: readonly string[];
	readonly ignored: readonly string[];
}

export type FeatureTrack =
	| { readonly slug: string; readonly ok: true; readonly meta: FeatureTrackMeta; readonly body: string }
	| { readonly slug: string; readonly ok: false; readonly error: string; readonly line: number | null };

export interface ReviewFile {
	readonly path: string;
	readonly oldPath: string | null;
	readonly status: "added" | "modified" | "deleted" | "renamed";
	readonly binary: boolean;
	readonly added: readonly { readonly line: number; readonly text: string }[];
	readonly removed: number;
}

export interface ReviewCheckInput {
	readonly sessionId: string;
	/** The turn under review, or null for the whole session. */
	readonly turn: number | null;
	/** Unified diff, as git prints it. */
	readonly patch: string;
	readonly files: readonly ReviewFile[];
}

export interface ReviewCheckResult {
	readonly outcome: "pass" | "warn" | "fail";
	readonly summary: string;
	readonly findings: readonly { readonly file: string; readonly line: number | null; readonly message: string }[];
}

export interface ReviewCheck {
	/** Lowercase letters, digits, ".", "_" and "-". */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** Answer within 10 seconds; a throw or a timeout shows as an error. */
	run(input: ReviewCheckInput): ReviewCheckResult | Promise<ReviewCheckResult>;
}

export interface HermesPluginAPIv2 extends Omit<HermesPluginAPI, "agents" | "apiVersion"> {
	apiVersion: 2;
	agents: HermesPluginAPI["agents"] & {
		/** A session's status, identity and turns. Requires "sessions.read". */
		getStatus(sessionId: string): AgentSessionState;
		/** Every event of every session, whatever the agent. Requires "sessions.read". */
		onEvent(listener: (e: { sessionId: string; event: SessionEvent }) => void): Disposable;
		/** Status transitions only. Requires "sessions.read". */
		onStatusChange(listener: (e: { sessionId: string; status: AgentStatus; previous: AgentStatus }) => void): Disposable;
	};
	/** Requires "inbox.raise". At most 20 open items per plugin; they go when the plugin is turned off. */
	inbox: {
		raise(item: { kind: InboxKind; sessionId?: string | null; detail: string }): InboxItem;
		/** Only items you raised. */
		resolve(id: string): boolean;
		list(): readonly InboxItem[];
	};
	/** Read-only. Requires "features.read". */
	features: {
		list(sessionId: string): Promise<readonly FeatureTrack[]>;
		get(sessionId: string, slug: string): Promise<FeatureTrack | null>;
	};
	/** Requires "review.checks". */
	review: {
		registerCheck(check: ReviewCheck): Disposable;
	};
}
