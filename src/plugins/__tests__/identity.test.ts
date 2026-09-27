import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
	claimHostKey,
	hostInvoke,
	issuePluginToken,
	revokePluginToken,
	invokeAsPlugin,
	bindPluginInvoke,
	_resetPluginIdentityForTests,
} from "../identity";
import { HOST_KEY, identityInvoke, tokenFor } from "./identityMock";

const mockInvoke = vi.mocked(invoke);

function callsTo(command: string) {
	return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
}

describe("plugin identity (host key + plugin tokens)", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation(identityInvoke);
		_resetPluginIdentityForTests();
	});

	describe("host key", () => {
		it("is claimed from the backend once and reused for every host call", async () => {
			expect(await claimHostKey()).toBe(HOST_KEY);
			expect(await claimHostKey()).toBe(HOST_KEY);
			await hostInvoke("save_plugin_metadata", { pluginId: "a" });
			await hostInvoke("set_plugin_enabled", { pluginId: "a", enabled: false });
			expect(callsTo("claim_plugin_host_key")).toHaveLength(1);
		});

		it("is attached to host commands as hostKey, without touching other arguments", async () => {
			await hostInvoke("cleanup_plugin_data", { pluginId: "acme.good" });
			expect(mockInvoke).toHaveBeenLastCalledWith("cleanup_plugin_data", { pluginId: "acme.good", hostKey: HOST_KEY });
		});

		it("a refused claim fails the host call and is not cached", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "claim_plugin_host_key") throw new Error("already claimed");
				return undefined;
			});
			await expect(hostInvoke("save_plugin_metadata", {})).rejects.toThrow(/host key unavailable/i);
			expect(callsTo("save_plugin_metadata")).toHaveLength(0);

			// The backend recovers (new page): the next attempt claims again.
			mockInvoke.mockImplementation(identityInvoke);
			await hostInvoke("save_plugin_metadata", {});
			expect(callsTo("claim_plugin_host_key")).toHaveLength(2);
		});

		it("an empty or non-string key from the backend is refused", async () => {
			mockInvoke.mockResolvedValue(undefined);
			await expect(claimHostKey()).rejects.toThrow(/host key/i);
			mockInvoke.mockResolvedValue("");
			await expect(claimHostKey()).rejects.toThrow(/host key/i);
		});
	});

	describe("plugin tokens", () => {
		it("are minted with the host key and are specific to the plugin", async () => {
			const good = await issuePluginToken("acme.good");
			const other = await issuePluginToken("acme.other");
			expect(good).toBe(tokenFor("acme.good"));
			expect(other).toBe(tokenFor("acme.other"));
			expect(good).not.toBe(other);
			expect(mockInvoke).toHaveBeenCalledWith("issue_plugin_token", { pluginId: "acme.good", hostKey: HOST_KEY });
		});

		it("a bound invoke sends the token and never a plugin id", async () => {
			const call = bindPluginInvoke("tok-x");
			await call("plugin_fetch_url", { url: "http://127.0.0.1/", headers: null });
			expect(mockInvoke).toHaveBeenLastCalledWith("plugin_fetch_url", { url: "http://127.0.0.1/", headers: null, pluginToken: "tok-x" });
			const [, args] = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
			expect(args).not.toHaveProperty("pluginId");
			expect(args).not.toHaveProperty("hostKey");
		});

		it("host UI addresses a plugin through its current token", async () => {
			await issuePluginToken("acme.good");
			await invokeAsPlugin("acme.good", "get_plugin_settings_batch");
			expect(mockInvoke).toHaveBeenLastCalledWith("get_plugin_settings_batch", { pluginToken: tokenFor("acme.good") });
		});

		it("host UI can address a plugin that has no token yet by minting one", async () => {
			await invokeAsPlugin("acme.idle", "set_plugin_setting", { key: "k", value: "v" });
			expect(mockInvoke).toHaveBeenCalledWith("issue_plugin_token", { pluginId: "acme.idle", hostKey: HOST_KEY });
			expect(mockInvoke).toHaveBeenLastCalledWith("set_plugin_setting", { key: "k", value: "v", pluginToken: tokenFor("acme.idle") });
		});

		it("revoking tells the backend and forgets the token locally", async () => {
			await issuePluginToken("acme.good");
			await revokePluginToken("acme.good");
			expect(mockInvoke).toHaveBeenLastCalledWith("revoke_plugin_token", { pluginId: "acme.good", hostKey: HOST_KEY });
			// The next host-UI call mints a fresh one rather than reusing a dead token.
			await invokeAsPlugin("acme.good", "get_plugin_settings_batch");
			expect(callsTo("issue_plugin_token")).toHaveLength(2);
		});

		it("an empty token from the backend is refused", async () => {
			mockInvoke.mockImplementation(async (cmd) => (cmd === "claim_plugin_host_key" ? HOST_KEY : ""));
			await expect(issuePluginToken("acme.good")).rejects.toThrow(/issued no token/);
		});
	});
});
