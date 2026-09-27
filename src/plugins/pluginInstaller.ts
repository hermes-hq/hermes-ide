import { hostInvoke } from "./identity";

export type InstallPhase = "downloading" | "extracting" | "done";

/**
 * Download a plugin .tgz from a URL and install it.
 * The download + extraction happens entirely in Rust to bypass WebView CSP.
 */
export async function downloadAndInstallPlugin(
    downloadUrl: string,
    onProgress?: (phase: InstallPhase) => void,
): Promise<string> {
    onProgress?.("downloading");

    const pluginId = await hostInvoke<string>("download_and_install_plugin", { url: downloadUrl });

    onProgress?.("done");

    return pluginId;
}
