/**
 * Plugin identity: who is really calling.
 *
 * Plugin bundles run in the same webview as the app, so any bundle can call
 * `window.__TAURI_INTERNALS__.invoke` and name any plugin id. The backend
 * therefore no longer trusts a caller-supplied id:
 *
 *   - Commands a plugin may use take a per-plugin **token**. The token is
 *     minted by the backend, handed to that plugin's API object only, and
 *     invalidated when the plugin is deactivated.
 *   - Management commands (install, permissions, enable) take the **host
 *     key**, which the backend hands out exactly once per page load. This
 *     module claims it before any plugin bundle executes and keeps it in
 *     module scope, which no plugin can reach.
 *
 * Nothing in this file is exposed on `window`; keep it that way.
 */
import { invoke } from "@tauri-apps/api/core";

type Args = Record<string, unknown>;

interface IdentityStore {
	hostKey: Promise<string> | null;
	/** plugin id -> the token its API object holds right now */
	tokens: Map<string, string>;
}

// Survives a Vite hot update of this module in dev; irrelevant in production.
const store: IdentityStore = (import.meta.hot?.data?.pluginIdentity as IdentityStore | undefined) ?? {
	hostKey: null,
	tokens: new Map<string, string>(),
};
if (import.meta.hot?.data) import.meta.hot.data.pluginIdentity = store;

/**
 * The host key for this page load. Claimed on first use and cached; a
 * failed claim is not cached so a later attempt can try again.
 */
export function claimHostKey(): Promise<string> {
	if (!store.hostKey) {
		store.hostKey = invoke<string>("claim_plugin_host_key").then(
			(key) => {
				if (typeof key !== "string" || key.length === 0) {
					throw new Error("the backend returned no host key");
				}
				return key;
			},
			(err) => {
				store.hostKey = null;
				throw new Error(`Plugin host key unavailable: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	}
	return store.hostKey;
}

/** Invoke a host-only plugin management command. */
export async function hostInvoke<T>(command: string, args: Args = {}): Promise<T> {
	const hostKey = await claimHostKey();
	return invoke<T>(command, { ...args, hostKey });
}

/**
 * The token that identifies `pluginId` to the backend. Idempotent: the same
 * token comes back until `revokePluginToken` is called.
 */
export async function issuePluginToken(pluginId: string): Promise<string> {
	const token = await hostInvoke<string>("issue_plugin_token", { pluginId });
	if (typeof token !== "string" || token.length === 0) {
		throw new Error(`the backend issued no token for plugin "${pluginId}"`);
	}
	store.tokens.set(pluginId, token);
	return token;
}

/** Invalidate the plugin's token: whatever still holds it can no longer act. */
export async function revokePluginToken(pluginId: string): Promise<void> {
	store.tokens.delete(pluginId);
	await hostInvoke("revoke_plugin_token", { pluginId });
}

/**
 * Invoke a token-bound command on behalf of `pluginId` from host UI (for
 * example the plugin settings form). Uses the plugin's current token.
 */
export async function invokeAsPlugin<T>(pluginId: string, command: string, args: Args = {}): Promise<T> {
	const token = store.tokens.get(pluginId) ?? (await issuePluginToken(pluginId));
	return invoke<T>(command, { ...args, pluginToken: token });
}

/** A function that invokes token-bound commands as one plugin. */
export type PluginInvoke = <T>(command: string, args?: Args) => Promise<T>;

/** Bind an invoke to one token; captured by the plugin's API closures. */
export function bindPluginInvoke(pluginToken: string): PluginInvoke {
	return <T>(command: string, args: Args = {}) => invoke<T>(command, { ...args, pluginToken });
}

/** @internal Forget the claimed key and tokens (tests only). */
export function _resetPluginIdentityForTests(): void {
	store.hostKey = null;
	store.tokens.clear();
}
