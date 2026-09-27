import { describe, it, expect } from "vitest";
import { buildLaunchPreview } from "../catalog/agentCatalog";

// The preview shown in the session creator and Settings must match the line
// the backend runs (`ai_launch_command` in the Rust PTY module), which starts
// the standalone `copilot` command, not the retired `gh copilot` extension.
describe("Copilot launch command", () => {
	it("default mode launches the copilot command", () => {
		expect(buildLaunchPreview("copilot", "default", "", "")).toBe("copilot");
	});

	it("wraps a prefix and suffix around the copilot command", () => {
		expect(buildLaunchPreview("copilot", "default", "caffeinate -i", "")).toBe("caffeinate -i copilot");
		expect(buildLaunchPreview("copilot", "default", "wsl", "--debug")).toBe("wsl copilot --debug");
	});

	it("never previews the retired gh extension", () => {
		expect(buildLaunchPreview("copilot", "bypassPermissions", "", "")).toBe("copilot --allow-all");
		expect(buildLaunchPreview("copilot", "default", "", "")).not.toMatch(/\bgh\b/);
	});
});
