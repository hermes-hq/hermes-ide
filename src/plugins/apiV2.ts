/**
 * Plugin API v2 (F36): what a plugin that declares `"apiVersion": 2` gets on
 * top of v1.
 *
 *   agents.onEvent / onStatusChange / getStatus
 *                  the normalised SessionEvents and AgentStatus of every
 *                  session, whatever the agent (docs/adr/004, sections 1-2).
 *                  Replaces the Claude-shaped agents.watchTranscript.
 *   inbox.raise / resolve / list
 *                  items in the attention inbox, stamped "plugin:<id>" by the
 *                  host (section 5).
 *   features.list / get
 *                  the repository's feature tracks, read-only (section 6).
 *   review.registerCheck
 *                  a check the Review Desk runs over a diff (section 7).
 *
 * Every payload handed to a plugin is a frozen copy: a plugin can never
 * change what the app, or another plugin, sees.
 */
import type { SessionEvent } from "../agent/contract/events";
import type { AgentStatus } from "../agent/contract/status";
import {
	getSessionEventSnapshot,
	subscribeAllSessionEvents,
	type SessionIdentity,
	type SessionTurnState,
} from "../agent/contract/sessionEventStore";
import {
	isInboxKind,
	listInboxItems,
	raiseInboxItemFromPlugin,
	resolveInboxItem,
	type InboxItem,
	type PluginInboxRaise,
} from "../agent/contract/inbox";
import { parseFeatureFrontMatter, type FeatureMeta } from "../agent/contract/featureFrontMatter";
import { registerReviewCheck, type ReviewCheckDefinition } from "../agent/contract/reviewChecks";
import type { PluginInvoke } from "./identity";
import type { Disposable } from "./types";

/** The release that stops loading v1 plugins (one minor after v2 ships). */
export const PLUGIN_API_V1_REMOVED_IN = "2.2";
/** Open inbox items one plugin may hold at once. */
export const MAX_PLUGIN_INBOX_ITEMS = 20;
/** Longest inbox detail a plugin may raise; longer text is cut. */
export const MAX_PLUGIN_INBOX_DETAIL = 200;

export type PluginApiResolution =
	| { readonly ok: true; readonly version: 1 | 2; readonly deprecated: boolean }
	| { readonly ok: false; readonly reason: "needs-flag" | "unsupported"; readonly version: unknown; readonly message: string };

/**
 * Which API a plugin gets. No `apiVersion` means 1. With the pluginApiV2
 * flag off everything behaves as before v2 existed: v1 for everyone, no
 * deprecation, and a v2 plugin is refused (it would call namespaces that
 * are not there). Built-in plugins ship with the app and are never
 * reported as deprecated.
 */
export function resolvePluginApi(declared: unknown, v2Enabled: boolean, builtin = false): PluginApiResolution {
	const version = declared === undefined || declared === null ? 1 : declared;
	if (version === 1) return { ok: true, version: 1, deprecated: v2Enabled && !builtin };
	if (version === 2) {
		if (v2Enabled) return { ok: true, version: 2, deprecated: false };
		return {
			ok: false,
			reason: "needs-flag",
			version,
			message: "needs plugin API v2, which is not turned on in this version of Hermes",
		};
	}
	const supported = v2Enabled ? "v1 and v2" : "v1";
	return {
		ok: false,
		reason: "unsupported",
		version,
		message: `needs plugin API ${JSON.stringify(version)}; this version of Hermes supports ${supported}`,
	};
}

// ─── Public shapes ───────────────────────────────────────────────────

/** A session as the plugin API v2 describes it: the same for every agent. */
export interface PluginAgentState {
	readonly sessionId: string;
	readonly status: AgentStatus;
	readonly identity: SessionIdentity;
	readonly turn: SessionTurnState;
	readonly attention: string | null;
	readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
	/** 0 when nothing has been reported about the session yet. */
	readonly version: number;
}

export interface PluginSessionEvent {
	readonly sessionId: string;
	readonly event: SessionEvent;
}

export interface PluginStatusChange {
	readonly sessionId: string;
	readonly status: AgentStatus;
	readonly previous: AgentStatus;
}

export type PluginFeatureTrack =
	| {
			readonly slug: string;
			readonly ok: true;
			readonly meta: FeatureMeta;
			/** feature.md after its front matter. */
			readonly body: string;
	  }
	| { readonly slug: string; readonly ok: false; readonly error: string; readonly line: number | null };

export interface AgentsAPIv2 {
	getStatus(sessionId: string): PluginAgentState;
	onEvent(listener: (e: PluginSessionEvent) => void): Disposable;
	onStatusChange(listener: (e: PluginStatusChange) => void): Disposable;
}

export interface InboxAPI {
	raise(item: PluginInboxRaise): InboxItem;
	/** Only items this plugin raised; false for anything else. */
	resolve(id: string): boolean;
	/** This plugin's open items, oldest first. */
	list(): readonly InboxItem[];
}

export interface FeaturesAPI {
	/** Tracks of the repository the session works in, by slug. */
	list(sessionId: string): Promise<readonly PluginFeatureTrack[]>;
	get(sessionId: string, slug: string): Promise<PluginFeatureTrack | null>;
}

export interface ReviewAPI {
	registerCheck(check: ReviewCheckDefinition): Disposable;
}

export interface PluginApiV2Namespaces {
	agents: AgentsAPIv2;
	inbox: InboxAPI;
	features: FeaturesAPI;
	review: ReviewAPI;
}

export interface PluginApiV2Deps {
	pluginId: string;
	permissions: ReadonlySet<string>;
	/** Token-bound invoke for this plugin. */
	call: PluginInvoke;
	/** The working directory of a session the app knows, else null. */
	workingDirectory: (sessionId: string) => string | null | undefined | Promise<string | null | undefined>;
	/** Disposed when the plugin is deactivated. */
	subscriptions: Disposable[];
	/** How PermissionDeniedError is built (shared with v1). */
	deny: (permission: string) => Error;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
	}
	return value;
}

/** A copy the plugin may keep; changing it changes nothing else. */
function frozenCopy<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function agentState(sessionId: string): PluginAgentState {
	const s = getSessionEventSnapshot(sessionId);
	return frozenCopy({
		sessionId,
		status: s.status,
		identity: s.identity,
		turn: s.turn,
		attention: s.attention,
		exit: s.exit,
		version: s.version,
	});
}

function toTrack(file: { slug: string; text: string | null; error: string | null }): PluginFeatureTrack {
	if (typeof file.text !== "string") {
		return deepFreeze({ slug: file.slug, ok: false as const, error: file.error ?? "feature.md can't be read", line: null });
	}
	const parsed = parseFeatureFrontMatter(file.text);
	if (!parsed.ok) return deepFreeze({ slug: file.slug, ok: false as const, error: parsed.error, line: parsed.line });
	return deepFreeze({ slug: file.slug, ok: true as const, meta: structuredClone(parsed.meta), body: parsed.body });
}

// ─── The namespaces ──────────────────────────────────────────────────

export function createPluginApiV2(deps: PluginApiV2Deps): PluginApiV2Namespaces {
	const { pluginId, permissions, call, subscriptions, deny } = deps;
	const source = `plugin:${pluginId}`;
	const need = (permission: string) => {
		if (!permissions.has(permission)) throw deny(permission);
	};
	const own = () => listInboxItems().filter((i) => i.source === source);

	/** Deliver outside the store's dispatch; a throwing plugin hurts nobody. */
	const deliver = (label: string, fn: () => void) =>
		queueMicrotask(() => {
			try {
				fn();
			} catch (err) {
				console.warn(`[Plugin:${pluginId}] ${label} listener threw:`, err);
			}
		});

	const track = (unsubscribe: () => void): Disposable => {
		let done = false;
		const d: Disposable = {
			dispose() {
				if (done) return;
				done = true;
				unsubscribe();
				const at = subscriptions.indexOf(d);
				if (at !== -1) subscriptions.splice(at, 1);
			},
		};
		subscriptions.push(d);
		return d;
	};

	// A plugin's inbox items go when the plugin goes (disabled, uninstalled,
	// reloaded): nobody could act on them any more.
	subscriptions.push({
		dispose() {
			for (const item of own()) resolveInboxItem(item.id);
		},
	});

	const agents: AgentsAPIv2 = {
		getStatus(sessionId: string) {
			need("sessions.read");
			if (typeof sessionId !== "string" || sessionId === "") throw new Error("getStatus needs a session id");
			return agentState(sessionId);
		},
		onEvent(listener) {
			need("sessions.read");
			if (typeof listener !== "function") throw new Error("onEvent needs a function");
			return track(
				subscribeAllSessionEvents((sessionId, event) => {
					if (!event) return; // a cleared session is not an event
					const payload = frozenCopy({ sessionId, event });
					deliver("onEvent", () => listener(payload));
				}),
			);
		},
		onStatusChange(listener) {
			need("sessions.read");
			if (typeof listener !== "function") throw new Error("onStatusChange needs a function");
			return track(
				subscribeAllSessionEvents((sessionId, event, snapshot, before) => {
					if (!event) return; // a cleared session is not a status change
					const status = snapshot.status;
					const previous = before.status;
					const same =
						previous.kind === status.kind && previous.confidence === status.confidence && previous.detail === status.detail;
					if (same) return;
					const payload = frozenCopy({ sessionId, status, previous });
					deliver("onStatusChange", () => listener(payload));
				}),
			);
		},
	};

	const inbox: InboxAPI = {
		raise(item: PluginInboxRaise) {
			need("inbox.raise");
			if (!item || typeof item !== "object") throw new Error("inbox.raise needs { kind, detail }");
			if (!isInboxKind(item.kind)) throw new Error(`unknown inbox kind: ${JSON.stringify(item.kind)}`);
			if (typeof item.detail !== "string" || item.detail.trim() === "") throw new Error("inbox.raise needs a detail line");
			const sessionId = item.sessionId ?? null;
			if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "")) {
				throw new Error("inbox.raise: sessionId must be a session id or null");
			}
			const detail = item.detail.trim().replace(/\s+/g, " ").slice(0, MAX_PLUGIN_INBOX_DETAIL);
			const open = own();
			const same = open.find((i) => i.kind === item.kind && i.sessionId === sessionId && i.detail === detail);
			if (same) return same;
			if (open.length >= MAX_PLUGIN_INBOX_ITEMS) {
				throw new Error(`Plugin "${pluginId}" already has ${MAX_PLUGIN_INBOX_ITEMS} open inbox items; resolve some first`);
			}
			// Only kind, session and detail are taken: whatever else the plugin
			// passed (a `source`, an `id`) is ignored, the host stamps its own.
			return raiseInboxItemFromPlugin(pluginId, { kind: item.kind, sessionId, detail });
		},
		resolve(id: string) {
			need("inbox.raise");
			const item = listInboxItems().find((i) => i.id === id);
			if (!item || item.source !== source) return false;
			return resolveInboxItem(id);
		},
		list() {
			need("inbox.raise");
			return Object.freeze(own());
		},
	};

	const features: FeaturesAPI = {
		async list(sessionId: string) {
			need("features.read");
			if (typeof sessionId !== "string" || sessionId === "") throw new Error("features.list needs a session id");
			const directory = await deps.workingDirectory(sessionId);
			if (!directory) throw new Error(`no session with id ${JSON.stringify(sessionId)}`);
			const files = await call<{ slug: string; text: string | null; error: string | null }[]>("plugin_read_feature_tracks", {
				directory,
			});
			return Object.freeze((files ?? []).map(toTrack));
		},
		async get(sessionId: string, slug: string) {
			const all = await features.list(sessionId);
			return all.find((t) => t.slug === slug) ?? null;
		},
	};

	const review: ReviewAPI = {
		registerCheck(check: ReviewCheckDefinition) {
			need("review.checks");
			// Keep only what the registry needs; the plugin's object stays its own.
			const run = check?.run;
			const unregister = registerReviewCheck(source, {
				id: check?.id,
				title: check?.title,
				description: check?.description,
				run: typeof run === "function" ? (input) => run.call(check, input) : (run as never),
			});
			return track(unregister);
		},
	};

	return { agents, inbox, features, review };
}
