import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { downloadAndInstallPlugin } from "../pluginInstaller";
import { _resetPluginIdentityForTests } from "../identity";
import { HOST_KEY, identityInvoke } from "./identityMock";

const mockInvoke = vi.mocked(invoke);

/** The backend: identity commands as usual, the install command as given. */
function backend(install: (url: string) => Promise<string>) {
    mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === "download_and_install_plugin") return install(String((args as { url: string }).url));
        return identityInvoke(cmd, args);
    });
}

describe("downloadAndInstallPlugin", () => {
    beforeEach(() => {
        mockInvoke.mockReset();
        _resetPluginIdentityForTests();
    });

    it("calls Rust download_and_install_plugin command as the host", async () => {
        backend(async () => "test-plugin-id");

        const result = await downloadAndInstallPlugin("https://example.com/plugin.tgz");

        expect(mockInvoke).toHaveBeenCalledWith("download_and_install_plugin", {
            url: "https://example.com/plugin.tgz",
            hostKey: HOST_KEY,
        });
        expect(result).toBe("test-plugin-id");
    });

    it("calls progress callback", async () => {
        backend(async () => "test-id");

        const onProgress = vi.fn();
        await downloadAndInstallPlugin("https://example.com/plugin.tgz", onProgress);

        expect(onProgress).toHaveBeenCalledWith("downloading");
        expect(onProgress).toHaveBeenCalledWith("done");
    });

    it("throws on Rust error", async () => {
        backend(async () => { throw new Error("Download failed: HTTP 404"); });

        await expect(
            downloadAndInstallPlugin("https://example.com/missing.tgz")
        ).rejects.toThrow("Download failed: HTTP 404");
    });

    it("does not install when the host key cannot be claimed", async () => {
        const install = vi.fn(async () => "never");
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === "claim_plugin_host_key") throw new Error("already claimed");
            if (cmd === "download_and_install_plugin") return install();
            return identityInvoke(cmd, args);
        });

        await expect(downloadAndInstallPlugin("https://example.com/plugin.tgz")).rejects.toThrow(/host key/i);
        expect(install).not.toHaveBeenCalled();
    });
});
