/**
 * A stand-in for the backend's plugin-identity commands, for tests that mock
 * `@tauri-apps/api/core`. Behaves like the Rust side: one host key, tokens
 * only for callers that present it, `tok-<plugin id>` so assertions can name
 * the token a plugin should be using.
 */
export const HOST_KEY = "host-key-for-tests";

export function tokenFor(pluginId: string): string {
	return `tok-${pluginId}`;
}

export async function identityInvoke(command: string, rawArgs?: unknown): Promise<unknown> {
	const args = (rawArgs ?? {}) as Record<string, unknown>;
	switch (command) {
		case "claim_plugin_host_key":
			return HOST_KEY;
		case "issue_plugin_token":
			if (args.hostKey !== HOST_KEY) throw new Error("invalid host key");
			return tokenFor(String(args.pluginId));
		case "revoke_plugin_token":
			if (args.hostKey !== HOST_KEY) throw new Error("invalid host key");
			return undefined;
		default:
			return undefined;
	}
}
